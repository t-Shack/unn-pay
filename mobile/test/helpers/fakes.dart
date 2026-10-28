import 'package:unn_pay/services/api_client.dart';
import 'package:unn_pay/services/app_state.dart';
import 'package:unn_pay/services/secure_store.dart';

/// In-memory stand-ins for the platform backed services, so widget tests can
/// render real screens without a keychain, a network, or Firebase.

class FakeSecureStore implements SecureStore {
  final Map<String, String> _values = <String, String>{};
  Map<String, dynamic>? _student;

  @override
  Future<void> saveTokens({required String accessToken, required String refreshToken}) async {
    _values['access'] = accessToken;
    _values['refresh'] = refreshToken;
  }

  @override
  Future<String?> readAccessToken() async => _values['access'];

  @override
  Future<String?> readRefreshToken() async => _values['refresh'];

  @override
  Future<void> saveStudent(Map<String, dynamic> student) async => _student = student;

  @override
  Future<Map<String, dynamic>?> readStudent() async => _student;

  @override
  Future<bool> get hasSession async => _values.containsKey('refresh');

  @override
  Future<void> clearSession() async {
    _values.clear();
    _student = null;
  }
}

/// An ApiClient whose responses the test dictates. Every method records that it
/// was called, so a test can assert on what the screen asked for.
class FakeApiClient implements ApiClient {
  FakeApiClient({
    this.feesResponse,
    this.paymentResponse,
    this.historyResponse,
    this.initiateResponse,
    this.throwOnInitiate,
  });

  Map<String, dynamic>? feesResponse;
  Map<String, dynamic>? paymentResponse;
  Map<String, dynamic>? historyResponse;
  Map<String, dynamic>? initiateResponse;
  ApiException? throwOnInitiate;

  final List<String> calls = <String>[];
  int? lastFeeItemId;
  String? lastIdempotencyKey;

  @override
  String get baseUrl => 'http://test.local';

  @override
  void useBaseUrl(String baseUrl) => calls.add('useBaseUrl');

  @override
  Future<Map<String, dynamic>> fees() async {
    calls.add('fees');
    return feesResponse ?? <String, dynamic>{'items': <dynamic>[], 'total_outstanding': '0.00'};
  }

  @override
  Future<Map<String, dynamic>> initiatePayment(
    int feeItemId, {
    required String idempotencyKey,
  }) async {
    calls.add('initiatePayment');
    lastFeeItemId = feeItemId;
    lastIdempotencyKey = idempotencyKey;
    if (throwOnInitiate != null) throw throwOnInitiate!;
    return initiateResponse!;
  }

  @override
  Future<Map<String, dynamic>> payment(String reference) async {
    calls.add('payment');
    return paymentResponse ?? <String, dynamic>{};
  }

  @override
  Future<Map<String, dynamic>> history({int page = 1, int pageSize = 20}) async {
    calls.add('history');
    return historyResponse ??
        <String, dynamic>{
          'items': <dynamic>[],
          'pagination': <String, dynamic>{'page': 1, 'total_pages': 1, 'total': 0},
        };
  }

  @override
  Future<Map<String, dynamic>> login({
    required String matricNumber,
    required String password,
  }) async {
    calls.add('login');
    throw ApiException(
      'Incorrect matric number or password',
      code: 'invalid_credentials',
      status: 401,
    );
  }

  // --- everything else is unused by these tests -----------------------------

  @override
  Future<void> requestActivation(String matricNumber) async => calls.add('requestActivation');

  @override
  Future<Map<String, dynamic>> confirmActivation({
    required String matricNumber,
    required String code,
    required String password,
  }) async =>
      throw UnimplementedError();

  @override
  Future<void> forgotPassword(String matricNumber) async => calls.add('forgotPassword');

  @override
  Future<void> resetPassword({
    required String matricNumber,
    required String code,
    required String password,
  }) async =>
      calls.add('resetPassword');

  @override
  Future<void> logout() async => calls.add('logout');

  @override
  Future<Map<String, dynamic>> me() async => throw UnimplementedError();

  @override
  Future<List<int>> receiptPdf(String reference) async => <int>[37, 80, 68, 70];

  @override
  Future<void> registerDevice({required String token, required String platform}) async {}

  @override
  Future<void> unregisterDevice(String token) async {}

  @override
  void Function()? get onSessionExpired => null;
}

/// An AppState already signed in as a given student, for screens that require one.
Future<AppState> signedInState({
  required Map<String, dynamic> student,
  required FakeApiClient api,
}) async {
  final FakeSecureStore store = FakeSecureStore();
  await store.saveTokens(accessToken: 'access', refreshToken: 'refresh');
  await store.saveStudent(student);

  final AppState state = AppState(api: api, store: store);
  // Populate the session without going through the network.
  await state.signInForTest(student);
  return state;
}

const Map<String, dynamic> testStudent = <String, dynamic>{
  'student_id': 1,
  'matric_number': '2022/248400',
  'full_name': 'Chidera Okonkwo',
  'email': 'chidera@example.unn.edu.ng',
  'department': 'Computer Science',
  'level': '400',
  'status': 'active',
};
