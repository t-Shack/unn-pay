# UNN Pay — operations runbook

For whoever is on the end of the phone when a student says their money is gone.

**The first thing to know, and to say:** money that reached the University's
account is never lost by this system. If it could not be matched to a fee, it is
recorded in the unapplied payments queue with the payer's details, and it is
never deleted — not after the 90 day deadline, not ever. Every incident below is
about applying money correctly, not recovering it.

---

## Go-live checklist

Work down this list. Do not skip §1 or §7.

### 1. Secrets

```bash
openssl rand -hex 32   # JWT_ACCESS_SECRET
openssl rand -hex 32   # JWT_REFRESH_SECRET
openssl rand -hex 32   # RECEIPT_SIGNING_SECRET
```

`RECEIPT_SIGNING_SECRET` is the one that cannot be rotated casually: every
receipt already issued was signed with it, and changing it makes every one of
them fail verification. If it must ever be rotated, plan a re-signing migration
first.

Set `BANK_WEBHOOK_SECRET` to the value the bank was given. It must match exactly
or every webhook is rejected — correctly, but silently as far as students are
concerned, because the reconciliation sweep will quietly cover for it.

### 2. Database

Render provisions it. Then create a least privilege application user (spec
§13.9) — the application must not hold DDL rights in production:

```sql
CREATE USER unnpay_app WITH PASSWORD '<generated>';
GRANT CONNECT ON DATABASE unnpay TO unnpay_app;
GRANT USAGE ON SCHEMA public TO unnpay_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO unnpay_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO unnpay_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO unnpay_app;

-- The audit log is append only. The database enforces it with a trigger, and
-- this makes it true of permissions as well.
REVOKE UPDATE, DELETE ON audit_log FROM unnpay_app;
```

Migrations run as the owner, through Render's pre-deploy command. The running
application uses `unnpay_app`.

### 3. Migrations

They run automatically as the release command. To check:

```bash
npm run migrate:status
```

### 4. First Super Admin

There is no public admin registration endpoint, ever. From a Render shell:

```bash
ADMIN_PASSWORD='<a strong password>' npm run seed:superadmin -- \
  --staff-id=BUR001 --name="Full Name" --email=bursar@unn.edu.ng
```

The password is read from the environment, never from an argument — arguments
end up in shell history and in the process list.

### 5. Email

Before any real student traffic:

- Verify `pay.unn.edu.ng` (or the chosen sending domain) in Resend
- Add the SPF, DKIM and DMARC records Resend gives you
- Send a test to a Gmail address and confirm it lands in the inbox, not spam
- Confirm the paid tier is active; the free tier is ~100 emails/day and
  registration week will exceed that in an hour

If activation emails go to spam, students cannot activate, and the support load
lands on the Bursary counter.

### 6. Fee items

Create them in the dashboard before students arrive. Check that department and
level targeting is right: a fee with a blank department applies to everyone.

### 7. Prove the whole path works, in production, before students do

With `BANK_ADAPTER=gtbank` and real credentials:

1. Create a test student, activate the account, initiate a payment
2. Pay the exact amount from a real bank account
3. Confirm the webhook arrived (`webhook_events`, `processing_status=processed`)
4. Confirm the receipt was issued and verifies at `/verify/<code>`
5. Deliberately underpay a second reference, and confirm it lands in the
   unapplied queue and that both emails arrive
6. Confirm money reaches the University's collection account

Only then announce the system.

---

## Daily checks

Open the dashboard overview. Four numbers matter:

| Panel | Healthy | What it means if not |
|---|---|---|
| Circuit breaker | `closed` | The bank is failing. Payments still work; virtual accounts are queued |
| Pending over 30 minutes | Low and falling | Students starting payments and not finishing is normal. A rising number with no settlements is not |
| Open unapplied payments | Being worked through | Each one is a student whose money is not on their record |
| Failed permanently (dead outbox) | 0 | Notifications that gave up after 8 attempts. Someone was not told something |

---

## Incidents

### A student says they paid and it is not showing

1. Find the payment: dashboard → Transactions → filter by matric number.
2. Read the status:

| Status | Meaning | Do this |
|---|---|---|
| `Successful` | It worked | Ask them to pull to refresh. Give them the receipt number |
| `Pending` | We have not seen the money yet | Wait one sweep, 10 minutes. Then §"Money left the student's account but never arrived" |
| `UnderReview` | The money arrived but did not match | Go to the unapplied queue and resolve it |
| `Expired` | The reference timed out unpaid | They can start again. If they paid anyway, it will appear as an unapplied payment |
| `Failed` | The bank reported a failure | No money was taken. They can start again |

3. If there is no transaction at all, they never started a payment in the app.
   Ask what reference they quoted — if they paid to an old reference, look in
   the unapplied queue for `unknown_reference` or `expired_reference`.

### Money left the student's account but never arrived

Reconciliation runs every 10 minutes and looks two ways: it asks the bank about
every stale pending reference, and it lists everything the bank settled in the
last 24 hours. If money reached the University, one of those two passes finds it
without anyone doing anything.

If it has been more than 20 minutes:

1. Check the worker is running and its logs show `reconciliation sweep complete`
2. Check the circuit breaker on the dashboard. Open means the bank is not
   answering us; the sweep cannot see settlements it cannot fetch
3. Ask the student for the bank's own transaction reference and search
   `unapplied_payments` — if we received it but could not match it, it is there
4. If the bank shows the transfer and we have nothing at all after an hour, it
   is a bank side problem. Raise it with GTBank quoting the UNN reference and
   the session id from the student's bank

### The circuit breaker is open

The bank has failed 5 times in a row. What is still working:

- Students can start payments and get references
- Virtual account creation is queued and completes automatically when the bank
  returns
- Webhooks that do arrive are processed normally
- Every payment already made is unaffected

What to do:

1. Check the bank's own status, and the API logs for `bank call failed`
2. The circuit half opens after 60 seconds by itself and closes on the first
   success. It needs no intervention
3. If it stays open more than 15 minutes, contact the bank. Then tell the
   Bursary counter to expect students saying the app is "slow"

Do not restart the API to "clear" it. That loses nothing, but it fixes nothing
either, and the breaker will reopen immediately.

### A dead outbox entry

A notification that failed 8 times over roughly 8 hours. The payment it relates
to is fine — the outbox exists precisely so a notification failure cannot touch a
payment.

1. Read `last_error` on the dashboard
2. Common causes: Resend quota exhausted, a bad `EMAIL_FROM` domain, expired
   Firebase credentials
3. Fix the cause, then requeue:

```sql
UPDATE outbox
   SET status = 'pending', attempt_count = 0, next_attempt_at = NOW()
 WHERE status = 'dead';
```

4. Tell the affected students by another route if the message mattered — an
   unapplied payment notice, particularly, since it carries a deadline.

### A student says a receipt is fake

Open `https://pay.unn.edu.ng/verify/<code>`, or scan the QR.

- **Green, valid** — genuine, and the details shown are what the University holds
- **Signature mismatch** — the document was altered after it was issued
- **Not found** — the code was invented

A screenshot proves nothing. Only the verification page does.

### Duplicate payment

The database makes two successful payments for one fee item impossible. The
second becomes an unapplied payment with reason `duplicate_payment`.

Resolve it as **Mark for refund**, with a note recording the decision. Both
payments stay on record.

### Restoring the database

Render keeps daily backups. Before restoring anything, understand what a restore
costs here: every payment settled since the backup point is gone from the
database, while the money is still very much in the University's account.

After any restore:

1. Run the reconciliation sweep manually, with a widened lookback:

```js
const { runReconciliation } = require('./src/worker/jobs/reconcile');
runReconciliation({ lookbackHours: 72 }).then(console.log);
```

That re-applies every settlement the bank still reports, idempotently. It is the
designed recovery path.

2. Reconcile the bank statement against `transactions` for the gap period by
   hand, and expect to resolve some items through the unapplied queue.

---

## Changing bank

The whole point of the adapter design.

1. Write `src/adapters/bank/<newbank>Adapter.js`, implementing
   `BankCollectionAdapter`
2. Add one line to `REGISTRY` in `src/adapters/bank/index.js`
3. Add its `<NEWBANK>_*` environment variables
4. Point `BANK_ADAPTER` at it and deploy

Transactions minted under the old adapter keep working: each one records which
adapter created it, and settlements are always interpreted by that adapter. Let
the old references expire naturally rather than migrating them.

If any of those four steps requires touching a service or a controller, stop —
something has leaked out of the adapter, and it needs fixing before the switch.

---

## Things not to do

- **Do not edit `transactions` by hand.** Use the unapplied queue. Direct edits
  bypass the audit log, the receipt signature, and the double payment guard.
- **Do not delete an unapplied payment.** Ever. Resolve it, with a note. A
  student can come back a year later with a bank slip and be right.
- **Do not rotate `RECEIPT_SIGNING_SECRET`** without a re-signing plan. Every
  existing receipt fails verification the moment you do.
- **Do not run migrations at boot.** Concurrent instances race each other.
- **Do not put the API or worker on a free instance.** They sleep, and a
  sleeping API delays webhooks.
- **Do not set `NODE_ENV=development` in production.** The sandbox simulation
  routes, which invent settlements out of nothing, are gated on it.
