# UNN Pay

A fee collection platform owned and operated by the University of Nigeria,
Nsukka.

UNN currently collects fees through Remita, a shared national biller platform. When
that platform degrades, every institution on it degrades together, and UNN
suffers an outage caused by something that has nothing to do with UNN. This
system removes that shared dependency: UNN mints its own payment references and
collects through a direct bank partnership, over the same NIP and NIBSS rails the
banks themselves run on.

Independent of Remita. Dependent on one bank — which is the correct and
achievable form of independence, since collecting money directly would require a
CBN licence UNN does not hold and does not want.

---

## What is here

| Directory | What it is | State |
|---|---|---|
| `backend/` | Express API and background worker | Complete — 234 tests passing |
| `admin-dashboard/` | React SPA for the Bursary | Complete, builds clean |
| `mobile/` | Flutter app for students | Complete — analyzes clean, 41 tests passing, builds an Android APK |
| `render.yaml` | Live demo deployment (free tier, Neon) | Complete |
| `render.production.yaml` | Production deployment for all three services | Complete |
| `RUNBOOK.md` | What to do when something breaks | Complete |
| `README-PRESENTATION.md` | Commands for a live demo with the Android app | Complete |

The public receipt verification page is served by the API itself, at
`GET /verify/:code`, with no authentication and no build step.

---

## Getting it running in five minutes

You need Node 18+ and PostgreSQL 15+.

```bash
# 1. Database
createdb unnpay               # or, with no PostgreSQL installed: cd backend && npm run db:dev

# 2. Backend
cd backend
cp .env.example .env          # then edit DATABASE_URL and the three secrets
npm install
npm run migrate
npm run seed:demo             # a bursar, five students, six fee items
npm run dev                   # API on :4000

# 3. Worker, in a second terminal
cd backend && npm run dev:worker

# 4. Dashboard, in a third
cd admin-dashboard && npm install && npm run dev   # :5173
```

Generate the three secrets with `openssl rand -hex 32`. The application refuses
to start if any of them is missing or short — a misconfigured deployment fails
at boot, loudly, rather than at the first payment.

`npm run seed:demo` prints the Bursary login it creates.

### Walking through a whole payment, with no bank

Everything runs against `SandboxAdapter`, a deterministic simulation of a
partner bank. With `BANK_ADAPTER=sandbox` and `NODE_ENV` not production, the API
also exposes simulation routes so you can drive the entire lifecycle by hand.

```bash
# 1. A student activates. The OTP is printed in the worker log ("one-time code"),
#    because with no RESEND_API_KEY set the email provider logs instead of sending.
curl -X POST localhost:4000/api/v1/auth/activate/request \
  -H 'Content-Type: application/json' \
  -d '{"matric_number":"2022/248400"}'

curl -X POST localhost:4000/api/v1/auth/activate/confirm \
  -H 'Content-Type: application/json' \
  -d '{"matric_number":"2022/248400","code":"<from the log>","password":"Password123"}'
# -> access_token

# 2. Start a payment (the client sends a fee item id and nothing else)
curl -X POST localhost:4000/api/v1/payments/initiate \
  -H "Authorization: Bearer <access_token>" \
  -H 'Content-Type: application/json' \
  -d '{"fee_item_id":1}'
# -> UNN reference, virtual account number, exact amount

# 3. Pay it
curl -X POST localhost:4000/api/v1/sandbox/pay \
  -H 'Content-Type: application/json' \
  -d '{"unn_reference":"UNN2509xxxxxxxx"}'
```

Interesting variations on step 3:

```jsonc
{"unn_reference":"UNN...", "scenario":"underpayment"}   // opens an unapplied payment
{"unn_reference":"UNN...", "scenario":"overpayment"}    // likewise
{"unn_reference":"UNN...", "deliveries":3}              // one receipt, not three
{"unn_reference":"UNN...", "deliver_webhook":false}     // reconciliation must find it
{"unn_reference":"UNN259900000018"}                     // a reference never minted
```

And to watch the circuit breaker open:

```bash
curl -X POST localhost:4000/api/v1/sandbox/inject-fault \
  -H 'Content-Type: application/json' \
  -d '{"method":"mintVirtualAccount","mode":"error","times":10}'
```

These routes exist only when `NODE_ENV` is not `production` **and**
`BANK_ADAPTER` is `sandbox`. The guard is applied twice, in `app.js` and in the
router itself: a route that invents settlements must not exist anywhere near
real money.

---

## Architecture

```
Flutter app  ─┐
              ├─→  Express API  ─→  PostgreSQL
React SPA    ─┘         │
                        ├─→  Bank Collection Adapter  ─→  Partner bank
                        ├─→  FCM
                        └─→  Resend

Background worker ─→ same database, same adapter
```

The API and the worker share models and services but run as separate processes.
A slow reconciliation sweep must never block a student's request.

Every module is routes → controller → service → model. Controllers hold no
business logic and never touch the ORM; only services do.

### The bank adapter is the important part

Every byte of bank communication goes through one interface,
`BankCollectionAdapter`. Nothing else in the codebase may import a bank SDK,
know a bank's name, or parse a bank specific payload.

Two implementations ship:

- **`SandboxAdapter`** — a deterministic simulation. All development, the whole
  test suite, and every demo run against it.
- **`GTBankAdapter`** — the real one. It is the only file that knows GTBank
  exists. Its field names, status strings, date format, error codes and
  `GTBANK_*` configuration are confined to it.

Adding a second bank means writing one new file and adding one line to the
registry in `src/adapters/bank/index.js`. If a bank swap ever requires touching a
service or a controller, that is a defect in this build, not a migration cost.

The choice is per transaction, not global only: each transaction records which
adapter minted it, and a settlement is always interpreted by the adapter that
created it. Running two banks concurrently for redundancy is a router in front
of `get(name)`, not a rewrite.

### Resilience

The system's whole reason for existing is that it should not fall over when
something else does.

| Failure | What happens |
|---|---|
| Webhook never arrives | The reconciliation sweep finds the settlement within 10 minutes, two ways: by asking about each stale pending reference, and by listing everything the bank settled in the last 24 hours |
| Webhook arrives 5 times | One receipt. Idempotent on the bank's settlement id, enforced by a unique index, not by hope |
| Bank is down at mint time | The reference is still issued, the account is queued, and the student is told it is being generated. The worker completes it when the bank returns |
| Bank fails repeatedly | The circuit opens after 5 consecutive failures and fails fast for 60 seconds rather than piling onto a struggling bank |
| Email or push provider is down | Nothing. Notifications go through a transactional outbox and are retried with backoff. A notification failure can never roll back a settled payment |
| Student sends the wrong amount | An unapplied payment opens, no receipt is issued, and both the student and the Bursary are told the exact figures and the deadline |
| Two payments for one fee | The database refuses the second. The money is recorded as an unapplied duplicate, never absorbed |

---

## Testing

```bash
cd backend
npm test              # 234 tests
npm run test:coverage
```

The suite starts a **real PostgreSQL 17** instance automatically (via
`embedded-postgres`) and applies the production migrations to it. That is not
incidental: the behaviour under test includes partial unique indexes and
`SELECT ... FOR UPDATE`, and SQLite has neither, so testing against it would
prove nothing about the guarantees that matter.

| Suite | What it covers |
|---|---|
| `tests/unit` | Reference generation and Luhn, money handling, HMAC signing, backoff, circuit breaker, and a guard that fails the build if the bank abstraction leaks (§5.1) |
| `tests/integration/paymentLifecycle` | Initiate → webhook → receipt, expiry, under and overpayment, unknown reference, duplicates, reconciliation recovery |
| `tests/integration/auth` | Activation, OTP attempt limits, password reset, device registration, fee applicability |
| `tests/integration/admin` | CSV import (preview and commit), unapplied resolution, fee items, exports, access control |
| `tests/integration/security` | Signature rejection, replay windows, cross student access, token rotation and reuse detection, tampered receipts, enumeration, SQL injection |
| `tests/integration/failureInjection` | Bank timeouts, 500s and malformed payloads; circuit breaker; dead outbox entries |
| `tests/concurrency` | Simultaneous initiates, simultaneous webhooks, two references for one fee, sweep racing the webhook, receipt numbering under load |

Services sit at 90% statement and 94% line coverage, above the 80% the
specification asks for.

### Mobile

Verified on Flutter 3.47.2 / Dart 3.13.2 — `flutter analyze` reports no issues,
`flutter test` passes 41 tests, and the app compiles. See
`mobile/README.md` for how those checks are run on a machine with no Android SDK.

Three real defects were found by the concurrency suite while it was being
written, and fixed:

1. **Receipt numbers raced.** `MAX(serial) + 1` is not atomic; two settlements
   committing together minted the same number and one payment died on the unique
   constraint. Replaced with an atomic upsert against `receipt_sequences`.
2. **A blanket Sequelize `retry` masked errors.** Retrying any failed statement
   re-ran it inside an already aborted transaction, so a constraint violation the
   application knows how to handle came back as an opaque "current transaction is
   aborted". Now scoped to connection errors only.
3. **OTP attempt counting was rolled back.** The increment happened inside the
   transaction that then threw, so every failed attempt was undone and the five
   attempt limit never engaged. Attempt accounting is now committed separately
   from the activation it guards.

A fourth, in the same class, was found by the security suite: refresh token
**family revocation was also being rolled back** by the error thrown immediately
after it, so detecting a stolen token revoked nothing.

---

## Deployment

There are two Render blueprints:

- **`render.yaml` — the live demo.** Free tier, Neon PostgreSQL, sandbox bank.
  The worker's jobs run inside the API (`RUN_WORKER_IN_API=true`) because the
  free tier has no background workers. Migrations and the demo seed run in the
  build command. Activation codes appear in the API service's log, and payments
  are made with the `/api/v1/sandbox/pay` route. No real money, ever.
- **`render.production.yaml` — real fee collection.** Paid API and worker as
  separate services, Render database, migrations as a pre-deploy command.

See `RUNBOOK.md` for go-live steps and for what to do when something breaks.

Three points that are easy to get wrong:

- **Neither the API nor the worker may be on a free instance.** Free services
  sleep, and a sleeping API means a delayed webhook.
- **The worker is its own service**, not a timer inside the API.
- **Migrations are a release command**, never run at boot.

Configuration is entirely environment variables, there is no local filesystem
state and no in-memory session or job state, so moving to a UNN hosted server
later is a change of environment, not a change of code.

---

## Outstanding before go-live

1. **GTBank credentials and API documentation** (spec §5.1, §16). Until they
   arrive, `BANK_ADAPTER` stays `sandbox`. `GTBankAdapter` is written against
   GTBank's published collections API pattern, with every point that must be
   confirmed against the real contract marked `CONFIRM ON RECEIPT OF DOCS`. When
   the documentation lands, only those constants and the three `translate`
   functions change, and nothing outside that one file moves.
2. **A verified sending domain for Resend**, with SPF, DKIM and DMARC records,
   before any real student traffic. Without them activation codes land in spam
   and students are locked out of their own accounts.
3. **A paid Resend tier.** The free tier is around 100 emails a day; registration
   week will exceed that comfortably.
4. **Firebase project and credentials** for push.
5. **Certificate pins for the mobile app**, and always two of them — see
   `mobile/README.md`.

## For the thesis stage

- Chapter 4 and Table 4.1 specify MySQL 8.0. This is built on PostgreSQL 15+, as
  resolved in §3.1, and the text needs amending.
- The abstract and Chapter 4 reference Paystack and Remita. They should describe
  the UNN owned collection pipeline and the partner bank model instead.
