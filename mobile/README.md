# UNN Pay — student mobile app

Flutter, Android and iOS. Talks only to the UNN Pay API; it holds no business
logic of its own and never computes an amount.

## Generating the platform folders

The Dart source in `lib/` is complete. The `android/` and `ios/` folders are not
checked in, because they are generated and largely boilerplate. Create them once,
in this directory:

```bash
flutter create --project-name unn_pay --org ng.edu.unn --platforms android,ios .
flutter pub get
```

That leaves everything in `lib/` and `pubspec.yaml` untouched and fills in the
platform scaffolding around it. Then apply the four changes below.

## Required platform configuration

### 1. Android — minimum SDK

`flutter_secure_storage` needs API 23 or newer. In `android/app/build.gradle`:

```gradle
defaultConfig {
    minSdkVersion 23
    targetSdkVersion 34
}
```

### 2. Android — no cleartext traffic in release builds

The app must never send a student's credentials over plain HTTP in production.
In `android/app/src/main/AndroidManifest.xml`, on the `<application>` element:

```xml
android:usesCleartextTraffic="false"
```

Local development against `http://10.0.2.2:4000` still works, because a debug
build gets Flutter's own debug manifest, which permits cleartext.

### 3. Android — notification channel and permission

In `AndroidManifest.xml`, inside `<manifest>`:

```xml
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.INTERNET" />
```

and inside `<application>`:

```xml
<meta-data
    android:name="com.google.firebase.messaging.default_notification_channel_id"
    android:value="unn_pay_payments" />
```

The channel id must be exactly `unn_pay_payments` — the backend sends it on
every message (`src/adapters/push/fcm.js`).

### 4. Firebase

Push notifications need Firebase credentials, which are per project and are not
in this repository:

- Android: put `google-services.json` in `android/app/`
- iOS: put `GoogleService-Info.plist` in `ios/Runner/`

Both are listed in `.gitignore`. **The app runs fine without them** — Firebase
initialisation is wrapped in a try/catch and push simply stays off. The payment
screen polls every ten seconds regardless (spec §11.3), so a student never
depends on push to learn that their payment landed.

## Verification status

Verified on Flutter 3.47.2 / Dart 3.13.2:

```
flutter analyze   →  No issues found
flutter test      →  37 tests, all passing
flutter build web →  compiled successfully
```

The web build is not a deliverable — the app targets Android and iOS — but
compiling for it is the cheapest way to put every line of Dart through the real
compiler on a machine with no Android SDK. To repeat that check:

```bash
flutter create --platforms web .   # adds web/ only
flutter build web
rm -rf web build                   # web/ is gitignored
```

Expect one warning from the WASM dry run about `flutter_secure_storage_web`
using `dart:html`. That is inside a third party package and does not affect the
Android or iOS builds.

### The tests

| File | Covers |
|---|---|
| `test/models_test.dart` | Money and date formatting, and every wire model. Includes the rule that an unrecognised payment status falls back to *outstanding*, never to *paid* — showing a fee as paid when it is not would stop a student paying it |
| `test/screens_test.dart` | Renders the real sign in, activation, home and payment screens. Asserts that `initiate` sends a fee item id and an idempotency key and never an amount, that the under review banner appears, and that an expired reference says plainly not to pay to that account |

## Running


Against a backend on your machine, from the Android emulator (`10.0.2.2` is the
emulator's route to the host):

```bash
flutter run --dart-define=UNN_PAY_API_URL=http://10.0.2.2:4000
```

On a physical device on the same network, use your machine's LAN address.

## Building for release

Certificate pinning is mandatory in a production build (spec §13.11), and
`main.dart` asserts it. Get the pin from the deployed certificate:

```bash
openssl s_client -connect pay.unn.edu.ng:443 -servername pay.unn.edu.ng < /dev/null 2>/dev/null \
  | openssl x509 -outform DER \
  | openssl dgst -sha256 -binary \
  | base64
```

Then:

```bash
flutter build appbundle --release \
  --dart-define=UNN_PAY_API_URL=https://pay.unn.edu.ng \
  --dart-define=UNN_PAY_CERT_PINS=<current pin>,<next pin>
```

**Ship two pins, always.** The certificate in use and the one that will replace
it. A single pin means that the day the certificate is renewed, every installed
copy of the app stops working, and the fix requires a store release — days,
during which no student can pay.

## What lives where

| Path | Purpose |
|---|---|
| `lib/config.dart` | Build time configuration, supplied by `--dart-define` |
| `lib/services/api_client.dart` | HTTP, certificate pinning, token refresh |
| `lib/services/secure_store.dart` | Tokens in the keychain/keystore, never SharedPreferences |
| `lib/services/app_state.dart` | Session and fee list |
| `lib/services/push_service.dart` | FCM registration and foreground notifications |
| `lib/models/models.dart` | Wire models; money stays a string, never a double |
| `lib/screens/` | Sign in, activation, home, payment, receipt, history |

## Two rules this app follows without exception

1. **It never sends an amount.** `initiatePayment` posts a fee item id and
   nothing else. The server resolves the price (spec §11.3).
2. **It never treats money as a number.** Amounts arrive as fixed two decimal
   strings and are displayed as they arrived. `double` appears only inside the
   display formatter, and never in arithmetic (spec §7).
