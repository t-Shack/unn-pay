import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Token storage.
///
/// Tokens live in `flutter_secure_storage` — the iOS keychain and the Android
/// EncryptedSharedPreferences backed keystore — and never in SharedPreferences
/// (spec §13.11). SharedPreferences is a plaintext XML file on Android, readable
/// by anything with the device's storage, which for a payment app is not
/// acceptable.
class SecureStore {
  SecureStore({FlutterSecureStorage? storage})
      : _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
              iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock),
            );

  static const String _accessKey = 'unn_pay.access_token';
  static const String _refreshKey = 'unn_pay.refresh_token';
  static const String _studentKey = 'unn_pay.student';

  final FlutterSecureStorage _storage;

  Future<void> saveTokens({
    required String accessToken,
    required String refreshToken,
  }) async {
    await _storage.write(key: _accessKey, value: accessToken);
    await _storage.write(key: _refreshKey, value: refreshToken);
  }

  Future<String?> readAccessToken() => _storage.read(key: _accessKey);

  Future<String?> readRefreshToken() => _storage.read(key: _refreshKey);

  Future<void> saveStudent(Map<String, dynamic> student) =>
      _storage.write(key: _studentKey, value: jsonEncode(student));

  Future<Map<String, dynamic>?> readStudent() async {
    final String? raw = await _storage.read(key: _studentKey);
    if (raw == null) return null;
    try {
      return jsonDecode(raw) as Map<String, dynamic>;
    } catch (_) {
      return null;
    }
  }

  Future<bool> get hasSession async => (await readRefreshToken()) != null;

  Future<void> clearSession() async {
    await _storage.delete(key: _accessKey);
    await _storage.delete(key: _refreshKey);
    await _storage.delete(key: _studentKey);
  }
}
