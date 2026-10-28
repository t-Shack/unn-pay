# UNN Pay — presentation day

Commands to run so the app on your phone works. Everything runs on the laptop; the phone talks to it.

## Live version (no laptop needed)

UNN Pay is also deployed on Render, with the Neon database:

- Bursary dashboard: https://unn-pay-admin.onrender.com
- API: https://unn-pay-api.onrender.com
- Phone app: `UNN-Pay-live.apk`, one folder up. It talks to the live API out of the box.

Activation codes appear in the Render dashboard → **unn-pay-api** → **Logs** (search for `one-time code`).
Make the bank "receive" a payment with the same commands as below, using the live address:

```bash
curl -X POST https://unn-pay-api.onrender.com/api/v1/sandbox/pay -H 'Content-Type: application/json' \
  -d '{"unn_reference":"UNN2510XXXXXXXX"}'
```

The free Render plan sleeps after 15 idle minutes; open the dashboard a minute before presenting so it is awake.

The rest of this page is the laptop setup, using `UNN-Pay-demo.apk`.

The app is `UNN-Pay-demo.apk`, one folder up from this project:
`/home/shack/Documents/Project-deals/Lawrence - School Fees/UNN-Pay-demo.apk`

---

## 1. Install the app on the phone (once)

1. Send `UNN-Pay-demo.apk` to the phone (WhatsApp to yourself, USB cable, Bluetooth or Google Drive).
2. Tap it on the phone. If asked, allow **Install unknown apps** for the app you opened it with.
3. If Play Protect warns about an unknown developer, tap **More details → Install anyway**.

## 2. Start the system on the laptop (every time)

Open **four terminals**. Leave each one running.

**Terminal 1 — database**
```bash
cd "/home/shack/Documents/Project-deals/Lawrence - School Fees/unn-pay/backend"
npm run db:dev
```

**Terminal 2 — API**
```bash
cd "/home/shack/Documents/Project-deals/Lawrence - School Fees/unn-pay/backend"
npm run dev
```

**Terminal 3 — worker** (sends notifications, and prints activation codes)
```bash
cd "/home/shack/Documents/Project-deals/Lawrence - School Fees/unn-pay/backend"
npm run dev:worker
```

**Terminal 4 — Bursary dashboard** (open http://localhost:5173 in the browser)
```bash
cd "/home/shack/Documents/Project-deals/Lawrence - School Fees/unn-pay/admin-dashboard"
npm run dev
```

Check the API is up:
```bash
curl http://localhost:4000/health
```

## 3. Connect the phone

Use **one** of these.

### A. USB cable (works with no network at all)

Once only: on the phone, **Settings → About phone →** tap **Build number** 7 times, then **Settings → Developer options →** turn on **USB debugging**.

Every time you plug the phone in:
```bash
~/Android/Sdk/platform-tools/adb devices
~/Android/Sdk/platform-tools/adb reverse tcp:4000 tcp:4000
```
Accept **Allow USB debugging?** on the phone the first time. `adb devices` must list the phone as `device`, not `unauthorized`.

Open UNN Pay. It uses `http://127.0.0.1:4000` by default, which the cable now forwards to the laptop.

### B. Phone hotspot (no cable)

Once only, let the phone through the laptop's firewall:
```bash
sudo ufw allow 4000/tcp
```

Every time:
1. Turn on the phone's hotspot and connect the laptop to it.
2. Get the laptop's address:
   ```bash
   hostname -I
   ```
   Use the first address, e.g. `192.168.43.10`.
3. In the app, on the sign in screen, **press and hold the green UNN Pay logo**, type that address, tap **Test and save**.

To go back to the cable later, hold the logo again and tap **Reset**.

## 4. Accounts

The database already holds the demo data from the thesis screenshots.

| Who | Sign in with | Password |
|---|---|---|
| Student with payment history | `2022/248400` (Chidera Okonkwo) | `NewPass2026` |
| Student with nothing paid yet — best for a live payment | `2025/301145` (Adaeze Chukwuma) | `Password123` |
| Other students | `2022/248401`, `2023/119872`, `2021/554120`, `2024/770031` | `Password123` |
| Not activated yet — use for a live activation | `2023/118450`, `2022/249013`, `2024/771220`, `2025/402233` | (you choose) |
| Bursary, Super Admin (dashboard) | `bursar@unn.edu.ng` | `DemoBursary2026!` |
| Bursary Staff (dashboard) | `ifeoma.ugwu@unn.edu.ng` | `BursaryStaff2026` |

## 5. During the demo

**Activation or password reset code:** no email is really sent. Within about a minute, Terminal 3 prints a line containing `one-time code` with `"code":"123456"`. Type that code in the app.

**Make the bank "receive" a payment.** Tap **Pay now** in the app, note the payment reference (also on the dashboard's Transactions page), then:
```bash
curl -X POST http://localhost:4000/api/v1/sandbox/pay -H 'Content-Type: application/json' \
  -d '{"unn_reference":"UNN2510XXXXXXXX"}'
```
The app turns to **Payment received** within 10 seconds.

Other outcomes, same command with a different body:
```bash
-d '{"unn_reference":"UNN2510XXXXXXXX","scenario":"underpayment"}'   # Needs attention; appears in Unapplied payments
-d '{"unn_reference":"UNN2510XXXXXXXX","scenario":"overpayment"}'
-d '{"unn_reference":"UNN2510XXXXXXXX","status":"failed"}'           # Payment did not go through
-d '{"unn_reference":"UNN2510XXXXXXXX","deliveries":3}'              # bank notifies 3 times, still one receipt
```

**Show the app surviving a bank outage:**
```bash
curl -X POST http://localhost:4000/api/v1/sandbox/inject-fault -H 'Content-Type: application/json' \
  -d '{"method":"mintVirtualAccount","mode":"error","times":10}'
```
Tap **Pay now**: the app says the reference is being generated. Then restore the bank:
```bash
curl -X POST http://localhost:4000/api/v1/sandbox/clear-faults
```
The worker completes the account within a minute and the screen updates itself.

## 6. If something goes wrong

| Problem | Fix |
|---|---|
| App says "Could not reach UNN Pay" | Terminal 2 running? Cable: run the `adb reverse` line again. Hotspot: laptop still on the hotspot, address unchanged (`hostname -I`), firewall rule added. |
| `adb devices` shows `unauthorized` | Unplug, replug, accept the prompt on the phone. Use a data cable, not a charge-only one. |
| `npm run dev` says port 4000 is in use | An old API is still running: close that terminal, or run `fuser -k 4000/tcp`. |
| Start with a completely empty database | Stop Terminal 1, then run the block below. |

```bash
cd "/home/shack/Documents/Project-deals/Lawrence - School Fees/unn-pay/backend"
rm -rf .pgdata
npm run db:dev            # Terminal 1, leave running
npm run migrate           # in another terminal
npm run seed:demo         # one bursar, five students, six fees; students must activate
```

## 7. Rebuild the app (only if you change the Flutter code)

```bash
cd "/home/shack/Documents/Project-deals/Lawrence - School Fees/unn-pay/mobile"
export JAVA_HOME=~/Android/jdk-21 ANDROID_HOME=~/Android/Sdk
flutter build apk --release --dart-define=UNN_PAY_API_URL=http://127.0.0.1:4000 -P unnPayAllowCleartext=true
cp build/app/outputs/flutter-apk/app-release.apk "../../UNN-Pay-demo.apk"
```

This is a demonstration build: it talks plain HTTP to a laptop. A production build uses the university's HTTPS address and certificate pins, and has no server setting.
