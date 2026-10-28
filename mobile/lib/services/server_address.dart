import 'package:dio/dio.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../config.dart';

/// Which server a development or demonstration build talks to.
///
/// The address is compiled in with `--dart-define=UNN_PAY_API_URL`, but a demo
/// laptop's address changes with the network it joins. So a non production
/// build lets the presenter change it on the phone (long press the logo on the
/// sign in screen) instead of rebuilding the app. A production build ignores
/// all of this: it talks to its compiled in, pinned HTTPS address and nothing
/// else (§13.11).
///
/// The address is not sensitive, so it lives in SharedPreferences.
class ServerAddress {
  const ServerAddress._();

  static const String _key = 'unn_pay.api_base_url';

  /// Whether this build may be pointed elsewhere at all.
  static bool get isConfigurable => !AppConfig.isProduction;

  /// The address to start with: a saved override, else the compiled in one.
  static Future<String> load() async {
    if (!isConfigurable) return AppConfig.apiBaseUrl;
    try {
      final SharedPreferences prefs = await SharedPreferences.getInstance();
      return prefs.getString(_key) ?? AppConfig.apiBaseUrl;
    } catch (_) {
      return AppConfig.apiBaseUrl;
    }
  }

  static Future<void> save(String address) async {
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, address);
  }

  static Future<void> reset() async {
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    await prefs.remove(_key);
  }

  /// Turn what a person types into a base URL, or null if it is not one.
  ///
  ///   192.168.43.10        -> http://192.168.43.10:4000
  ///   192.168.43.10:4000/  -> http://192.168.43.10:4000
  static String? normalise(String input) {
    String value = input.trim();
    if (value.isEmpty) return null;
    if (!value.contains('://')) value = 'http://$value';
    final Uri? uri = Uri.tryParse(value);
    if (uri == null || uri.host.isEmpty || !(uri.scheme == 'http' || uri.scheme == 'https')) {
      return null;
    }
    // Read the port from the text: Uri hides one that equals the scheme's
    // default, so "http://host:80" and "http://host" would look the same.
    final RegExpMatch? explicit = RegExp(r'^[a-z]+://[^/?#]*:(\d+)').firstMatch(value);
    final int port = explicit != null
        ? int.parse(explicit.group(1)!)
        : (uri.scheme == 'https' ? 443 : 4000);
    final bool defaultPort =
        (uri.scheme == 'https' && port == 443) || (uri.scheme == 'http' && port == 80);
    return '${uri.scheme}://${uri.host}${defaultPort ? '' : ':$port'}';
  }

  /// True if a UNN Pay API answers its health check at [address].
  static Future<bool> isReachable(String address) async {
    try {
      final Response<dynamic> response = await Dio(
        BaseOptions(
          connectTimeout: const Duration(seconds: 5),
          receiveTimeout: const Duration(seconds: 5),
        ),
      ).get<dynamic>('$address/health');
      final dynamic body = response.data;
      return response.statusCode == 200 && body is Map && body['service'] == 'unn-pay-api';
    } catch (_) {
      return false;
    }
  }
}
