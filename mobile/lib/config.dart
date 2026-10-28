/// Build time configuration.
///
/// Supplied with `--dart-define`, so a debug build pointed at a laptop and a
/// release build pointed at production are the same source with different
/// values, and no environment file ever ships inside the app bundle.
///
///   flutter run \
///     --dart-define=UNN_PAY_API_URL=http://10.0.2.2:4000
///
///   flutter build apk --release \
///     --dart-define=UNN_PAY_API_URL=https://pay.unn.edu.ng \
///     --dart-define=UNN_PAY_CERT_PINS=`<base64 sha256 of the leaf certificate>`
class AppConfig {
  const AppConfig._();

  /// 10.0.2.2 is the host machine as seen from the Android emulator.
  static const String apiBaseUrl = String.fromEnvironment(
    'UNN_PAY_API_URL',
    defaultValue: 'http://10.0.2.2:4000',
  );

  /// Comma separated base64 SHA-256 hashes of accepted server certificates
  /// (§13.11). Ship at least two: the certificate in use and its planned
  /// replacement, so a renewal cannot lock every student out of the app.
  static const String _pins = String.fromEnvironment('UNN_PAY_CERT_PINS');

  static List<String> get certificatePins =>
      _pins.isEmpty ? const [] : _pins.split(',').map((p) => p.trim()).where((p) => p.isNotEmpty).toList();

  static bool get isProduction => apiBaseUrl.startsWith('https://');

  /// How often the payment screen polls while it is open (§11.3). Push is the
  /// primary channel; this is the complement for a device with notifications
  /// switched off.
  static const Duration pollInterval = Duration(seconds: 10);
}
