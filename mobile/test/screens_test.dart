import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:unn_pay/screens/auth_screens.dart';
import 'package:unn_pay/screens/home_screen.dart';
import 'package:unn_pay/screens/payment_screen.dart';
import 'package:unn_pay/models/models.dart';
import 'package:unn_pay/services/api_client.dart';
import 'package:unn_pay/services/app_state.dart';

import 'helpers/fakes.dart';

/// Widget tests.
///
/// These render the real screens. Their value is not the assertions so much as
/// the rendering itself: a screen that throws in `build` fails here rather than
/// on a student's phone.

Widget wrap(Widget child) => MaterialApp(home: child);

Map<String, dynamic> feesPayload({String status = 'outstanding'}) => <String, dynamic>{
      'items': <dynamic>[
        <String, dynamic>{
          'fee_item_id': 1,
          'name': 'School Fees (Undergraduate)',
          'category': 'Tuition',
          'amount': '68500.00',
          'amount_formatted': '₦68,500.00',
          'session': '2025/2026',
          'payment_status': status,
        },
        <String, dynamic>{
          'fee_item_id': 2,
          'name': 'Hostel Accommodation',
          'category': 'Hostel',
          'amount': '18000.00',
          'amount_formatted': '₦18,000.00',
          'session': '2025/2026',
          'payment_status': 'paid',
          'paid_at': '2025-08-15T10:30:00.000Z',
        },
      ],
      'total_outstanding': '68500.00',
      'total_outstanding_formatted': '₦68,500.00',
    };

Map<String, dynamic> paymentPayload({
  String status = 'Pending',
  bool accountPending = false,
  String? amountPaid,
}) =>
    <String, dynamic>{
      'unn_reference': 'UNN250880118774',
      'status': status,
      'expected_amount': '68500.00',
      'expected_amount_formatted': '₦68,500.00',
      'amount_paid': amountPaid,
      'amount_paid_formatted': amountPaid == null ? null : '₦60,000.00',
      'virtual_account_number': accountPending ? null : '9012345678',
      'virtual_account_bank': accountPending ? null : 'UNN Pay Sandbox Bank',
      'virtual_account_pending': accountPending,
      'channels': <dynamic>['transfer', 'ussd', 'card', 'pos', 'bank_branch'],
      'expires_at': DateTime.now().toUtc().add(const Duration(hours: 8)).toIso8601String(),
      'paid_at': null,
      'fee_item': <String, dynamic>{'fee_item_id': 1, 'name': 'School Fees (Undergraduate)'},
      'receipt': null,
    };

void main() {
  group('SignInScreen', () {
    testWidgets('renders and explains that registration is not open', (WidgetTester tester) async {
      final AppState state = AppState(api: FakeApiClient(), store: FakeSecureStore());
      await tester.pumpWidget(wrap(SignInScreen(state: state)));

      expect(find.text('UNN Pay'), findsOneWidget);
      expect(find.text('University of Nigeria, Nsukka'), findsOneWidget);
      expect(find.text('Sign in'), findsOneWidget);
      expect(find.text('Activate my account'), findsOneWidget);
      expect(
        find.textContaining('must already be registered with the Bursary'),
        findsOneWidget,
      );
    });

    testWidgets('validates the matric number format before calling the API',
        (WidgetTester tester) async {
      final FakeApiClient api = FakeApiClient();
      final AppState state = AppState(api: api, store: FakeSecureStore());
      await tester.pumpWidget(wrap(SignInScreen(state: state)));

      await tester.enterText(find.byType(TextFormField).first, '1234');
      await tester.enterText(find.byType(TextFormField).last, 'Password123');
      await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
      await tester.pump();

      expect(find.textContaining('like 2022/248400'), findsOneWidget);
      // Nothing left the device.
      expect(api.calls, isEmpty);
    });

    testWidgets('formats the matric number as it is typed', (WidgetTester tester) async {
      final AppState state = AppState(api: FakeApiClient(), store: FakeSecureStore());
      await tester.pumpWidget(wrap(SignInScreen(state: state)));

      // Read the field's own value rather than searching the tree by text: the
      // hint is the same string, and matching on text would find both.
      String fieldText() =>
          tester.widget<EditableText>(find.byType(EditableText).first).controller.text;

      await tester.enterText(find.byType(TextFormField).first, '2022248400');
      await tester.pump();
      expect(fieldText(), '2022/248400');

      // The slash is inserted, not required, and non digits are dropped.
      await tester.enterText(find.byType(TextFormField).first, '2022/248400');
      await tester.pump();
      expect(fieldText(), '2022/248400');

      await tester.enterText(find.byType(TextFormField).first, 'abc2022xy248400');
      await tester.pump();
      expect(fieldText(), '2022/248400');

      // A partial entry is left alone rather than being padded.
      await tester.enterText(find.byType(TextFormField).first, '2022');
      await tester.pump();
      expect(fieldText(), '2022');
    });

    testWidgets('shows the server\'s message when credentials are wrong',
        (WidgetTester tester) async {
      final FakeApiClient api = FakeApiClient();
      final AppState state = AppState(api: api, store: FakeSecureStore());
      await tester.pumpWidget(wrap(SignInScreen(state: state)));

      await tester.enterText(find.byType(TextFormField).first, '2022248400');
      await tester.enterText(find.byType(TextFormField).last, 'wrong');
      await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
      await tester.pumpAndSettle();

      expect(find.text('Incorrect matric number or password'), findsOneWidget);
      expect(api.calls, contains('login'));
    });
  });

  group('OtpFlowScreen', () {
    testWidgets('asks for a matric number, then for the code', (WidgetTester tester) async {
      final FakeApiClient api = FakeApiClient();
      final AppState state = AppState(api: api, store: FakeSecureStore());
      await tester.pumpWidget(wrap(OtpFlowScreen(state: state, mode: OtpFlowMode.activate)));

      expect(find.text('Activate your account'), findsOneWidget);
      expect(find.text('Send me a code'), findsOneWidget);

      await tester.enterText(find.byType(TextFormField).first, '2022248400');
      await tester.tap(find.text('Send me a code'));
      await tester.pumpAndSettle();

      expect(api.calls, contains('requestActivation'));
      // The wording never confirms whether the account exists.
      expect(find.textContaining('If that matric number is registered'), findsOneWidget);
      expect(find.text('Activate account'), findsOneWidget);
    });

    testWidgets('rejects a weak password without calling the API', (WidgetTester tester) async {
      final FakeApiClient api = FakeApiClient();
      final AppState state = AppState(api: api, store: FakeSecureStore());
      await tester.pumpWidget(wrap(OtpFlowScreen(state: state, mode: OtpFlowMode.activate)));

      await tester.enterText(find.byType(TextFormField).first, '2022248400');
      await tester.tap(find.text('Send me a code'));
      await tester.pumpAndSettle();

      final Finder fields = find.byType(TextFormField);
      await tester.enterText(fields.at(0), '123456');
      await tester.enterText(fields.at(1), 'short');
      await tester.enterText(fields.at(2), 'short');
      await tester.tap(find.text('Activate account'));
      await tester.pump();

      expect(find.textContaining('at least 8 characters'), findsOneWidget);
    });
  });

  group('HomeScreen', () {
    testWidgets('shows the outstanding total and the student\'s fees',
        (WidgetTester tester) async {
      final FakeApiClient api = FakeApiClient(feesResponse: feesPayload());
      final AppState state = await signedInState(student: testStudent, api: api);

      await tester.pumpWidget(wrap(HomeScreen(state: state)));
      await tester.pumpAndSettle();

      expect(find.text('₦68,500.00'), findsWidgets);
      expect(find.text('School Fees (Undergraduate)'), findsOneWidget);
      expect(find.text('Hostel Accommodation'), findsOneWidget);
      expect(find.text('2022/248400 · Computer Science'), findsOneWidget);

      // Outstanding fees are payable; a paid fee is not.
      expect(find.text('Pay now'), findsOneWidget);
      expect(find.text('Paid'), findsOneWidget);
    });

    testWidgets('shows the persistent banner when a payment is under review',
        (WidgetTester tester) async {
      final FakeApiClient api = FakeApiClient(feesResponse: feesPayload(status: 'under_review'));
      final AppState state = await signedInState(student: testStudent, api: api);

      await tester.pumpWidget(wrap(HomeScreen(state: state)));
      await tester.pumpAndSettle();

      expect(find.text('A payment needs your attention'), findsOneWidget);
      expect(find.textContaining('Your money is safe and recorded'), findsOneWidget);
    });

    testWidgets('sends a fee item id and an idempotency key, and never an amount',
        (WidgetTester tester) async {
      final FakeApiClient api = FakeApiClient(
        feesResponse: feesPayload(),
        initiateResponse: <String, dynamic>{'payment': paymentPayload()},
      );
      final AppState state = await signedInState(student: testStudent, api: api);

      await tester.pumpWidget(wrap(HomeScreen(state: state)));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Pay now'));
      await tester.pumpAndSettle();

      expect(api.lastFeeItemId, 1);
      expect(api.lastIdempotencyKey, isNotNull);
      expect(api.lastIdempotencyKey, startsWith('pay-1-1-'));
    });

    testWidgets('explains a fee already under review rather than showing a raw error',
        (WidgetTester tester) async {
      final FakeApiClient api = FakeApiClient(
        feesResponse: feesPayload(),
        throwOnInitiate: ApiException('conflict', code: 'fee_under_review', status: 409),
      );
      final AppState state = await signedInState(student: testStudent, api: api);

      await tester.pumpWidget(wrap(HomeScreen(state: state)));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Pay now'));
      await tester.pumpAndSettle();

      expect(find.text('Cannot start this payment'), findsOneWidget);
      expect(find.textContaining('so you are not charged twice'), findsOneWidget);
    });

    testWidgets('renders an empty fee list without breaking', (WidgetTester tester) async {
      final FakeApiClient api = FakeApiClient(
        feesResponse: <String, dynamic>{
          'items': <dynamic>[],
          'total_outstanding': '0.00',
          'total_outstanding_formatted': '₦0.00',
        },
      );
      final AppState state = await signedInState(student: testStudent, api: api);

      await tester.pumpWidget(wrap(HomeScreen(state: state)));
      await tester.pumpAndSettle();

      expect(find.text('No fees right now'), findsOneWidget);
    });
  });

  group('PaymentScreen', () {
    testWidgets('shows the account number, exact amount and reference',
        (WidgetTester tester) async {
      final FakeApiClient api = FakeApiClient(
        paymentResponse: <String, dynamic>{'payment': paymentPayload()},
      );
      final AppState state = await signedInState(student: testStudent, api: api);
      final Payment payment = Payment.fromJson(paymentPayload());

      await tester.pumpWidget(wrap(PaymentScreen(state: state, payment: payment)));
      await tester.pump();

      expect(find.text('9012345678'), findsOneWidget);
      expect(find.text('UNN Pay Sandbox Bank'), findsOneWidget);
      expect(find.text('UNN250880118774'), findsOneWidget);
      expect(find.text('₦68,500.00'), findsWidgets);
      expect(find.textContaining('Send the exact amount'), findsOneWidget);

      // Every channel resolves to the same account (§5.2).
      expect(find.text('Bank transfer'), findsOneWidget);
      expect(find.text('USSD'), findsOneWidget);
      expect(find.text('POS terminal'), findsOneWidget);

      await tester.pumpAndSettle(const Duration(milliseconds: 100));
    });

    testWidgets('tells the student the account is being generated after a bank outage',
        (WidgetTester tester) async {
      final FakeApiClient api = FakeApiClient(
        paymentResponse: <String, dynamic>{'payment': paymentPayload(accountPending: true)},
      );
      final AppState state = await signedInState(student: testStudent, api: api);
      final Payment payment = Payment.fromJson(paymentPayload(accountPending: true));

      await tester.pumpWidget(wrap(PaymentScreen(state: state, payment: payment)));
      await tester.pump();

      expect(find.text('Your payment reference is being generated'), findsOneWidget);
      expect(find.textContaining('nothing is lost'), findsOneWidget);
      // No account number is shown, because there is not one yet.
      expect(find.text('9012345678'), findsNothing);

      await tester.pumpAndSettle(const Duration(milliseconds: 100));
    });

    testWidgets('explains an under review payment with both amounts',
        (WidgetTester tester) async {
      final Map<String, dynamic> underReview =
          paymentPayload(status: 'UnderReview', amountPaid: '60000.00');
      final FakeApiClient api = FakeApiClient(
        paymentResponse: <String, dynamic>{'payment': underReview},
      );
      final AppState state = await signedInState(student: testStudent, api: api);

      await tester.pumpWidget(
        wrap(PaymentScreen(state: state, payment: Payment.fromJson(underReview))),
      );
      await tester.pump();

      expect(find.text('Your payment needs attention'), findsOneWidget);
      expect(find.textContaining('Your money has not been lost'), findsOneWidget);
      expect(find.text('₦60,000.00'), findsWidgets);
      expect(find.text('Amount expected'), findsOneWidget);

      await tester.pumpAndSettle(const Duration(milliseconds: 100));
    });

    testWidgets('warns clearly when the reference has expired', (WidgetTester tester) async {
      final Map<String, dynamic> expired = paymentPayload();
      expired['expires_at'] =
          DateTime.now().toUtc().subtract(const Duration(hours: 1)).toIso8601String();

      final FakeApiClient api = FakeApiClient(
        paymentResponse: <String, dynamic>{'payment': expired},
      );
      final AppState state = await signedInState(student: testStudent, api: api);

      await tester.pumpWidget(
        wrap(PaymentScreen(state: state, payment: Payment.fromJson(expired))),
      );
      await tester.pump();

      expect(find.text('This reference has expired'), findsOneWidget);
      expect(find.textContaining('Do not pay to this account number'), findsOneWidget);

      await tester.pumpAndSettle(const Duration(milliseconds: 100));
    });
  });
}
