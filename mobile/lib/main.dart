import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';

import 'config.dart';
import 'screens/auth_screens.dart';
import 'screens/main_shell.dart';
import 'services/api_client.dart';
import 'services/app_state.dart';
import 'services/push_service.dart';
import 'services/secure_store.dart';
import 'services/server_address.dart';
import 'theme/theme.dart';

/// Background message handler. Must be a top level function.
@pragma('vm:entry-point')
Future<void> _onBackgroundMessage(RemoteMessage message) async {
  // The system displays the notification itself; nothing to do here beyond
  // making sure Firebase is initialised in the background isolate.
  await Firebase.initializeApp();
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final SecureStore store = SecureStore();

  // A production build must never talk to an unpinned or plaintext endpoint.
  assert(
    !AppConfig.isProduction || AppConfig.certificatePins.isNotEmpty,
    'A production build must be given UNN_PAY_CERT_PINS (spec §13.11)',
  );

  late final AppState state;

  final ApiClient api = ApiClient(
    // The compiled in address, or one a presenter set on the phone (non
    // production builds only).
    baseUrl: await ServerAddress.load(),
    store: store,
    pinnedPublicKeySha256: AppConfig.certificatePins,
    onSessionExpired: () => state.onSessionExpired(),
  );

  PushService? push;
  try {
    await Firebase.initializeApp();
    FirebaseMessaging.onBackgroundMessage(_onBackgroundMessage);
    push = PushService(api: api);
    await push.initialise();
  } catch (error) {
    // Firebase is not configured (no google-services.json). The app works
    // fully without it: the payment screen polls as well as listening.
    debugPrint('Push notifications are unavailable: $error');
  }

  state = AppState(api: api, store: store, push: push);
  await state.bootstrap();

  runApp(UnnPayApp(state: state));
}

class UnnPayApp extends StatelessWidget {
  const UnnPayApp({super.key, required this.state});

  final AppState state;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'UNN Pay',
      debugShowCheckedModeBanner: false,
      theme: UnnTheme.light,
      home: AnimatedBuilder(
        animation: state,
        builder: (BuildContext context, _) {
          if (state.loading) {
            return const Scaffold(
              backgroundColor: UnnTheme.forest,
              body: Center(
                  child: CircularProgressIndicator(color: UnnTheme.gold),),
            );
          }
          return state.isSignedIn
              ? MainShell(state: state)
              : SignInScreen(state: state);
        },
      ),
    );
  }
}
