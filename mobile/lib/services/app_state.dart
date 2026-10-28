import 'package:flutter/foundation.dart';

import '../models/models.dart';
import 'api_client.dart';
import 'push_service.dart';
import 'secure_store.dart';

/// Application state.
///
/// A ChangeNotifier rather than a state management package: this app has one
/// authenticated user, one list of fees, and one payment in flight at a time.
/// Anything heavier would be scaffolding around a problem that does not exist.
class AppState extends ChangeNotifier {
  AppState({required this.api, required this.store, this.push});

  final ApiClient api;
  final SecureStore store;
  final PushService? push;

  Student? _student;
  FeeList? _fees;
  bool _loading = true;
  String? _error;

  Student? get student => _student;
  FeeList? get fees => _fees;
  bool get loading => _loading;
  String? get error => _error;
  bool get isSignedIn => _student != null;

  /// Restore a session on launch. A stored session that the server has since
  /// revoked is cleared silently — the student just sees the sign in screen.
  Future<void> bootstrap() async {
    _loading = true;
    notifyListeners();

    try {
      if (await store.hasSession) {
        final Map<String, dynamic>? cached = await store.readStudent();
        if (cached != null) _student = Student.fromJson(cached);

        // Confirm with the server; this also refreshes the access token.
        final Map<String, dynamic> fresh = await api.me();
        _student = Student.fromJson(fresh['student'] as Map<String, dynamic>);
        await store.saveStudent(fresh['student'] as Map<String, dynamic>);
        await _afterSignIn();
      }
    } on ApiException catch (error) {
      // Only a rejected session signs the student out. A flaky connection at
      // launch must not throw away a perfectly good login.
      if (!error.isNetwork && (error.status == 401 || error.status == 403)) {
        await store.clearSession();
        _student = null;
      }
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  Future<void> signIn({required String matricNumber, required String password}) async {
    final Map<String, dynamic> response =
        await api.login(matricNumber: matricNumber, password: password);
    _student = Student.fromJson(response['student'] as Map<String, dynamic>);
    notifyListeners();
    await _afterSignIn();
  }

  Future<void> activate({
    required String matricNumber,
    required String code,
    required String password,
  }) async {
    final Map<String, dynamic> response = await api.confirmActivation(
      matricNumber: matricNumber,
      code: code,
      password: password,
    );
    _student = Student.fromJson(response['student'] as Map<String, dynamic>);
    notifyListeners();
    await _afterSignIn();
  }

  Future<void> signOut() async {
    await push?.unregister();
    await api.logout();
    _student = null;
    _fees = null;
    notifyListeners();
  }

  /// Seed the session directly, without a network round trip.
  ///
  /// Exists so widget tests can render the signed in screens. It performs no
  /// authentication of its own and is never reachable from the app: nothing in
  /// `lib/` calls it, and it grants nothing the caller does not already hold —
  /// the tokens still come from the store, and the server still checks them.
  @visibleForTesting
  Future<void> signInForTest(Map<String, dynamic> student) async {
    _student = Student.fromJson(student);
    await refreshFees();
  }

  /// Called when the API reports the session is gone (a revoked token family).
  void onSessionExpired() {
    _student = null;
    _fees = null;
    notifyListeners();
  }

  Future<void> _afterSignIn() async {
    await push?.registerWithBackend();
    await refreshFees();
  }

  Future<void> refreshFees() async {
    try {
      _fees = FeeList.fromJson(await api.fees());
      _error = null;
    } on ApiException catch (error) {
      _error = error.message;
    }
    notifyListeners();
  }
}
