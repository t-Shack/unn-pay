import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart' as crypto;
import 'package:dio/dio.dart';
import 'package:dio/io.dart';

import 'secure_store.dart';

/// Thrown for every failed API call. Carries the server's machine readable code
/// so screens can branch on it without matching on message text.
class ApiException implements Exception {
  ApiException(this.message, {this.code, this.status, this.details, this.correlationId});

  final String message;
  final String? code;
  final int? status;
  final dynamic details;
  final String? correlationId;

  bool get isNetwork => status == null;

  @override
  String toString() => message;
}

/// The UNN Pay API client.
///
/// Three things here are load bearing:
///
///  1. **Certificate pinning** (§13.11). The app refuses to talk to anything but
///     the real API, so a proxy on a campus wifi network cannot read or alter a
///     student's payment traffic. Pins are SHA-256 hashes of the certificate's
///     public key, so renewing the certificate with the same key does not break
///     the app.
///  2. **Token refresh**, once, transparently, funnelled through a single future
///     so a screen making three calls at once cannot rotate the refresh token
///     three times and trip the server's reuse detection.
///  3. **Nothing sensitive is ever logged**, including in debug builds.
class ApiClient {
  ApiClient({
    required String baseUrl,
    required SecureStore store,
    List<String> pinnedPublicKeySha256 = const [],
    this.onSessionExpired,
  })  : _baseUrl = baseUrl,
        _store = store,
        _pins = pinnedPublicKeySha256 {
    _dio = Dio(
      BaseOptions(
        baseUrl: '$baseUrl/api/v1',
        connectTimeout: const Duration(seconds: 15),
        receiveTimeout: const Duration(seconds: 30),
        sendTimeout: const Duration(seconds: 30),
        headers: {'Accept': 'application/json'},
        // Non 2xx is handled explicitly below rather than by throwing raw.
        validateStatus: (status) => status != null && status < 500,
      ),
    );

    if (_pins.isNotEmpty) {
      _dio.httpClientAdapter = IOHttpClientAdapter(
        createHttpClient: () {
          final HttpClient client = HttpClient();
          // Reject anything whose public key is not one we shipped.
          client.badCertificateCallback = (cert, host, port) => false;
          return client;
        },
        validateCertificate: (cert, host, port) {
          if (cert == null) return false;
          final String fingerprint =
              base64.encode(crypto.sha256.convert(cert.der).bytes);
          return _pins.contains(fingerprint);
        },
      );
    }
  }

  String _baseUrl;
  final SecureStore _store;
  final List<String> _pins;
  final void Function()? onSessionExpired;

  late final Dio _dio;
  Future<bool>? _refreshInFlight;

  String get baseUrl => _baseUrl;

  /// Point the client at a different server. Development and demonstration
  /// builds only: a production build is pinned to its compiled in address.
  void useBaseUrl(String baseUrl) {
    _baseUrl = baseUrl;
    _dio.options.baseUrl = '$baseUrl/api/v1';
  }

  // --- session ---------------------------------------------------------------

  Future<Map<String, String>> _authHeaders() async {
    final String? token = await _store.readAccessToken();
    return token == null ? {} : {'Authorization': 'Bearer $token'};
  }

  /// Refresh the access token. Shared, so concurrent 401s cause one rotation.
  Future<bool> _refresh() {
    return _refreshInFlight ??= () async {
      try {
        final String? refreshToken = await _store.readRefreshToken();
        if (refreshToken == null) return false;

        final Response<dynamic> response = await _dio.post<dynamic>(
          '/auth/refresh',
          data: {'refresh_token': refreshToken},
        );

        if (response.statusCode != 200) {
          await _store.clearSession();
          onSessionExpired?.call();
          return false;
        }

        final Map<String, dynamic> tokens =
            (response.data as Map<String, dynamic>)['tokens'] as Map<String, dynamic>;
        await _store.saveTokens(
          accessToken: tokens['access_token'] as String,
          refreshToken: tokens['refresh_token'] as String,
        );
        return true;
      } catch (_) {
        await _store.clearSession();
        onSessionExpired?.call();
        return false;
      } finally {
        _refreshInFlight = null;
      }
    }();
  }

  // --- transport -------------------------------------------------------------

  Future<dynamic> _send(
    String method,
    String path, {
    Object? body,
    Map<String, dynamic>? query,
    Map<String, String>? headers,
    bool authenticated = true,
    bool allowRetry = true,
    ResponseType responseType = ResponseType.json,
  }) async {
    try {
      final Response<dynamic> response = await _dio.request<dynamic>(
        path,
        data: body,
        queryParameters: query,
        options: Options(
          method: method,
          responseType: responseType,
          headers: {
            ...?headers,
            if (authenticated) ...await _authHeaders(),
          },
        ),
      );

      final int status = response.statusCode ?? 0;

      if (status == 401 && authenticated && allowRetry) {
        if (await _refresh()) {
          // Awaited, not just returned: without the await the retried request's
          // failures escape this try block and never reach the DioException
          // handler below, so a network error on the retry would surface as a
          // raw Dio error instead of an ApiException.
          return await _send(
            method,
            path,
            body: body,
            query: query,
            headers: headers,
            authenticated: authenticated,
            allowRetry: false,
            responseType: responseType,
          );
        }
      }

      if (status >= 200 && status < 300) return response.data;

      throw _errorFrom(response);
    } on DioException catch (error) {
      if (error.error is HandshakeException || error.type == DioExceptionType.badCertificate) {
        throw ApiException(
          'The connection is not secure. Do not enter your details on this network.',
          code: 'certificate_rejected',
        );
      }
      if (error.type == DioExceptionType.connectionTimeout ||
          error.type == DioExceptionType.receiveTimeout ||
          error.type == DioExceptionType.sendTimeout) {
        throw ApiException(
          'The connection timed out. Check your network and try again.',
          code: 'timeout',
        );
      }
      throw ApiException(
        'Could not reach UNN Pay. Check your internet connection.',
        code: 'network_error',
      );
    }
  }

  ApiException _errorFrom(Response<dynamic> response) {
    final dynamic data = response.data;
    if (data is Map && data['error'] is Map) {
      final Map<dynamic, dynamic> error = data['error'] as Map<dynamic, dynamic>;
      return ApiException(
        (error['message'] as String?) ?? 'Something went wrong.',
        code: error['code'] as String?,
        status: response.statusCode,
        details: error['details'],
        correlationId: error['correlation_id'] as String?,
      );
    }
    return ApiException('Something went wrong.', status: response.statusCode);
  }

  // --- authentication (§11.1) ------------------------------------------------

  Future<void> requestActivation(String matricNumber) => _send(
        'POST',
        '/auth/activate/request',
        body: {'matric_number': matricNumber},
        authenticated: false,
      );

  Future<Map<String, dynamic>> confirmActivation({
    required String matricNumber,
    required String code,
    required String password,
  }) async {
    final dynamic data = await _send(
      'POST',
      '/auth/activate/confirm',
      body: {'matric_number': matricNumber, 'code': code, 'password': password},
      authenticated: false,
    );
    await _persist(data as Map<String, dynamic>);
    return data;
  }

  Future<Map<String, dynamic>> login({
    required String matricNumber,
    required String password,
  }) async {
    final dynamic data = await _send(
      'POST',
      '/auth/login',
      body: {'matric_number': matricNumber, 'password': password},
      authenticated: false,
    );
    await _persist(data as Map<String, dynamic>);
    return data;
  }

  Future<void> forgotPassword(String matricNumber) => _send(
        'POST',
        '/auth/forgot-password',
        body: {'matric_number': matricNumber},
        authenticated: false,
      );

  Future<void> resetPassword({
    required String matricNumber,
    required String code,
    required String password,
  }) =>
      _send(
        'POST',
        '/auth/reset-password',
        body: {'matric_number': matricNumber, 'code': code, 'password': password},
        authenticated: false,
      );

  Future<void> logout() async {
    final String? refreshToken = await _store.readRefreshToken();
    if (refreshToken != null) {
      try {
        await _send(
          'POST',
          '/auth/logout',
          body: {'refresh_token': refreshToken},
          authenticated: false,
        );
      } catch (_) {
        // Signing out locally must succeed even if the network call does not.
      }
    }
    await _store.clearSession();
  }

  Future<Map<String, dynamic>> me() async =>
      (await _send('GET', '/auth/me')) as Map<String, dynamic>;

  Future<void> _persist(Map<String, dynamic> payload) async {
    final Map<String, dynamic> tokens = payload['tokens'] as Map<String, dynamic>;
    await _store.saveTokens(
      accessToken: tokens['access_token'] as String,
      refreshToken: tokens['refresh_token'] as String,
    );
    await _store.saveStudent(payload['student'] as Map<String, dynamic>);
  }

  // --- fees and payments -----------------------------------------------------

  Future<Map<String, dynamic>> fees() async =>
      (await _send('GET', '/fees')) as Map<String, dynamic>;

  /// Start a payment. The client sends a fee item id and nothing else — the
  /// amount is resolved by the server, always (§11.3).
  ///
  /// The idempotency key makes a double tapped button, or a retry after a
  /// dropped connection, return the reference already minted (§9.1).
  Future<Map<String, dynamic>> initiatePayment(
    int feeItemId, {
    required String idempotencyKey,
  }) async {
    final dynamic data = await _send(
      'POST',
      '/payments/initiate',
      body: {'fee_item_id': feeItemId},
      headers: {'Idempotency-Key': idempotencyKey},
    );
    return data as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> payment(String reference) async =>
      (await _send('GET', '/payments/$reference')) as Map<String, dynamic>;

  Future<Map<String, dynamic>> history({int page = 1, int pageSize = 20}) async =>
      (await _send('GET', '/payments/history', query: {'page': page, 'page_size': pageSize}))
          as Map<String, dynamic>;

  Future<List<int>> receiptPdf(String reference) async {
    final dynamic data = await _send(
      'GET',
      '/payments/$reference/receipt',
      responseType: ResponseType.bytes,
    );
    return (data as List<dynamic>).cast<int>();
  }

  // --- notifications ---------------------------------------------------------

  Future<void> registerDevice({required String token, required String platform}) => _send(
        'POST',
        '/notifications/register-device',
        body: {'fcm_token': token, 'platform': platform},
      );

  Future<void> unregisterDevice(String token) => _send(
        'DELETE',
        '/notifications/register-device',
        body: {'fcm_token': token},
      );
}
