import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:unn_pay/models/models.dart';
import 'package:unn_pay/screens/auth_screens.dart';
import 'package:unn_pay/screens/history_screen.dart';
import 'package:unn_pay/screens/home_screen.dart';
import 'package:unn_pay/screens/main_shell.dart';
import 'package:unn_pay/screens/payment_screen.dart';
import 'package:unn_pay/screens/receipt_screen.dart';
import 'package:unn_pay/services/app_state.dart';
import 'package:unn_pay/theme/theme.dart';

import 'helpers/fakes.dart';

/// Render tests for the screens added or rebuilt in the redesign, at a real
/// phone size, so a layout that overflows on a 390 x 844 screen fails here.

Widget wrap(Widget child) => MaterialApp(theme: UnnTheme.light, home: child);

void usePhoneSize(WidgetTester tester) {
  tester.view.physicalSize = const Size(390 * 3, 844 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

Map<String, dynamic> settledPayload() => <String, dynamic>{
      'unn_reference': 'UNN251048213067',
      'status': 'Successful',
      'expected_amount': '68500.00',
      'expected_amount_formatted': '₦68,500.00',
      'amount_paid': '68500.00',
      'amount_paid_formatted': '₦68,500.00',
      'virtual_account_number': '9012345678',
      'virtual_account_bank': 'UNN Pay Sandbox Bank',
      'virtual_account_pending': false,
      'channel': 'transfer',
      'channels': <dynamic>['transfer'],
      'expires_at': '2026-10-29T18:00:00.000Z',
      'paid_at': '2026-10-28T18:42:00.000Z',
      'fee_item': <String, dynamic>{
        'fee_item_id': 1,
        'name': 'School Fees (Undergraduate)',
      },
      'receipt': <String, dynamic>{
        'receipt_number': 'UNN/2025-2026/000142',
        'verification_code': 'UNN-7K4P-Q9ZD',
        'issued_at': '2026-10-28T18:42:05.000Z',
      },
    };

Map<String, dynamic> pendingPayload() => <String, dynamic>{
      'unn_reference': 'UNN251048213042',
      'status': 'Pending',
      'expected_amount': '18000.00',
      'expected_amount_formatted': '₦18,000.00',
      'amount_paid': null,
      'virtual_account_number': '9012345679',
      'virtual_account_bank': 'UNN Pay Sandbox Bank',
      'virtual_account_pending': false,
      'channels': <dynamic>['transfer'],
      'expires_at': DateTime.now()
          .toUtc()
          .add(const Duration(hours: 20))
          .toIso8601String(),
      'paid_at': null,
      'fee_item': <String, dynamic>{
        'fee_item_id': 2,
        'name': 'Hostel Accommodation',
      },
      'receipt': null,
    };

Map<String, dynamic> historyPayload() => <String, dynamic>{
      'items': <dynamic>[settledPayload(), pendingPayload()],
      'pagination': <String, dynamic>{'page': 1, 'total_pages': 1, 'total': 2},
    };

void main() {
  testWidgets(
      'a settled payment shows the success state and links to the receipt',
      (WidgetTester tester) async {
    usePhoneSize(tester);
    final AppState state =
        await signedInState(student: testStudent, api: FakeApiClient());

    await tester.pumpWidget(
      wrap(PaymentScreen(
          state: state, payment: Payment.fromJson(settledPayload()),),),
    );
    await tester.pump();

    expect(find.text('PAYMENT RECEIVED'), findsOneWidget);
    expect(find.text('UNN/2025-2026/000142'), findsOneWidget);
    expect(find.text('View receipt'), findsOneWidget);
    expect(find.text('Bank transfer'), findsOneWidget);

    await tester.pumpAndSettle(const Duration(milliseconds: 100));
  });

  testWidgets(
      'the receipt shows the stamp, the verification code and the PDF action',
      (WidgetTester tester) async {
    usePhoneSize(tester);
    final AppState state =
        await signedInState(student: testStudent, api: FakeApiClient());

    await tester.pumpWidget(
      wrap(ReceiptScreen(
          state: state, payment: Payment.fromJson(settledPayload()),),),
    );
    await tester.pump();

    expect(find.text('PAID IN FULL'), findsOneWidget);
    expect(find.text('UNN-7K4P-Q9ZD'), findsOneWidget);
    expect(find.text('Download PDF receipt'), findsOneWidget);
    expect(find.text('Signed by UNN'), findsOneWidget);
  });

  testWidgets('history groups payments and filters them',
      (WidgetTester tester) async {
    usePhoneSize(tester);
    final AppState state = await signedInState(
      student: testStudent,
      api: FakeApiClient(historyResponse: historyPayload()),
    );

    await tester.pumpWidget(wrap(HistoryScreen(state: state)));
    await tester.pumpAndSettle();

    expect(find.text('School Fees (Undergraduate)'), findsOneWidget);
    expect(find.text('Hostel Accommodation'), findsOneWidget);
    expect(find.text('OCTOBER 2026'), findsWidgets);

    await tester.tap(find.text('Paid').first);
    await tester.pumpAndSettle();

    expect(find.text('School Fees (Undergraduate)'), findsOneWidget);
    expect(find.text('Hostel Accommodation'), findsNothing);
  });

  testWidgets('the receipts tab lists only payments with a receipt',
      (WidgetTester tester) async {
    usePhoneSize(tester);
    final AppState state = await signedInState(
      student: testStudent,
      api: FakeApiClient(historyResponse: historyPayload()),
    );

    await tester
        .pumpWidget(wrap(HistoryScreen(state: state, receiptsOnly: true)));
    await tester.pumpAndSettle();

    // The screen title and the summary's receipt count both say "Receipts".
    expect(find.text('Receipts'), findsNWidgets(2));
    expect(find.text('School Fees (Undergraduate)'), findsOneWidget);
    expect(find.text('Hostel Accommodation'), findsNothing);
  });

  testWidgets('the shell moves between tabs and signs out from Profile',
      (WidgetTester tester) async {
    usePhoneSize(tester);
    final FakeApiClient api = FakeApiClient(historyResponse: historyPayload());
    final AppState state = await signedInState(student: testStudent, api: api);

    await tester.pumpWidget(wrap(MainShell(state: state)));
    await tester.pumpAndSettle();

    expect(find.text('Your fees'), findsOneWidget);

    Finder tab(String label) => find.descendant(
        of: find.byType(NavigationBar), matching: find.text(label),);

    await tester.tap(tab('History'));
    await tester.pumpAndSettle();
    expect(find.text('Paid so far'), findsOneWidget);

    await tester.tap(tab('Profile'));
    await tester.pumpAndSettle();
    expect(find.text('Sign out'), findsOneWidget);

    await tester.tap(find.text('Sign out'));
    await tester.pumpAndSettle();
    expect(find.text('Sign out?'), findsOneWidget);

    await tester.tap(find.widgetWithText(TextButton, 'Sign out'));
    await tester.pumpAndSettle();
    expect(state.isSignedIn, isFalse);
  });

  group('renders at phone size without overflowing', () {
    testWidgets('sign in', (WidgetTester tester) async {
      usePhoneSize(tester);
      final AppState state =
          AppState(api: FakeApiClient(), store: FakeSecureStore());
      await tester.pumpWidget(wrap(SignInScreen(state: state)));
      await tester.pumpAndSettle();
      expect(find.text('Welcome back'), findsOneWidget);
    });

    testWidgets('activation, code step', (WidgetTester tester) async {
      usePhoneSize(tester);
      final AppState state =
          AppState(api: FakeApiClient(), store: FakeSecureStore());
      await tester.pumpWidget(
          wrap(OtpFlowScreen(state: state, mode: OtpFlowMode.activate)),);
      await tester.enterText(find.byType(TextFormField).first, '2022248400');
      await tester.tap(find.text('Send me a code'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextFormField).at(0), '4829');
      await tester.pumpAndSettle();
      expect(find.text('Check your email'), findsOneWidget);
      expect(find.text('9'), findsOneWidget);
    });

    testWidgets('home with every fee state', (WidgetTester tester) async {
      usePhoneSize(tester);
      Map<String, dynamic> fee(
              int id, String name, String category, String status,) =>
          <String, dynamic>{
            'fee_item_id': id,
            'name': name,
            'category': category,
            'amount': '18000.00',
            'amount_formatted': '₦18,000.00',
            'session': '2025/2026',
            'payment_status': status,
            if (status == 'paid') 'paid_at': '2026-10-12T10:30:00.000Z',
          };
      final FakeApiClient api = FakeApiClient(
        feesResponse: <String, dynamic>{
          'items': <dynamic>[
            fee(1, 'School Fees (Undergraduate)', 'Tuition', 'outstanding'),
            fee(2, 'Hostel Accommodation', 'Hostel', 'pending'),
            fee(3, 'Departmental Dues — Computer Science', 'Departmental',
                'under_review',),
            fee(4, 'Sports and Games Levy', 'Other', 'paid'),
          ],
          'total_outstanding': '86500.00',
          'total_outstanding_formatted': '₦86,500.00',
        },
      );
      final AppState state =
          await signedInState(student: testStudent, api: api);
      await tester.pumpWidget(wrap(HomeScreen(state: state)));
      await tester.pumpAndSettle();
      expect(find.text('Continue'), findsOneWidget);
      expect(find.text('Under review'), findsOneWidget);
      expect(find.text('1 of 4 fees paid'), findsOneWidget);
    });

    for (final String status in <String>['Pending', 'UnderReview', 'Failed']) {
      testWidgets('payment, $status', (WidgetTester tester) async {
        usePhoneSize(tester);
        final Map<String, dynamic> payload = pendingPayload()
          ..['status'] = status
          ..['amount_paid'] = status == 'UnderReview' ? '15000.00' : null
          ..['amount_paid_formatted'] =
              status == 'UnderReview' ? '₦15,000.00' : null;
        final AppState state = await signedInState(
          student: testStudent,
          api: FakeApiClient(
              paymentResponse: <String, dynamic>{'payment': payload},),
        );
        await tester.pumpWidget(wrap(
            PaymentScreen(state: state, payment: Payment.fromJson(payload)),),);
        await tester.pump();
        expect(find.text('Make payment'), findsOneWidget);
        await tester.pumpAndSettle(const Duration(milliseconds: 100));
      });
    }
  });
}
