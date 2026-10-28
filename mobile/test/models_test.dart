import 'package:flutter_test/flutter_test.dart';
import 'package:unn_pay/models/models.dart';

/// Model parsing and money presentation.
///
/// These matter more than they look: every one of them sits between the API's
/// answer and what a student reads on a payment screen, and a wrong amount or a
/// wrong status here is indistinguishable to the student from the system being
/// broken.

void main() {
  group('formatNaira', () {
    test('formats an amount the API returned as a decimal string', () {
      expect(formatNaira('68500.00'), '₦68,500.00');
      expect(formatNaira('0.05'), '₦0.05');
      expect(formatNaira('1234567.89'), '₦1,234,567.89');
    });

    test('always shows two decimal places', () {
      expect(formatNaira('100.00'), '₦100.00');
      expect(formatNaira('100.5'), '₦100.50');
    });

    test('returns a dash for a missing amount rather than "null"', () {
      expect(formatNaira(null), '—');
      expect(formatNaira(''), '—');
    });

    test('passes through anything unparseable instead of inventing a number', () {
      expect(formatNaira('not-a-number'), 'not-a-number');
    });
  });

  group('formatWat', () {
    test('renders a UTC instant in West Africa Time', () {
      // 10:30 UTC is 11:30 WAT; Nigeria is UTC+1 all year, no daylight saving.
      final DateTime utc = DateTime.utc(2025, 8, 15, 10, 30);
      expect(formatWat(utc), '15 Aug 2025, 11:30 WAT');
    });

    test('crosses midnight correctly', () {
      final DateTime utc = DateTime.utc(2025, 8, 15, 23, 30);
      expect(formatWat(utc), '16 Aug 2025, 00:30 WAT');
    });

    test('can omit the time', () {
      expect(formatWat(DateTime.utc(2025, 8, 15, 10, 30), withTime: false), '15 Aug 2025');
    });

    test('returns a dash for a missing date', () {
      expect(formatWat(null), '—');
    });
  });

  group('Student', () {
    final Map<String, dynamic> json = <String, dynamic>{
      'student_id': 1,
      'matric_number': '2022/248400',
      'full_name': 'Chidera Okonkwo',
      'email': 'chidera@example.unn.edu.ng',
      'department': 'Computer Science',
      'level': '400',
      'status': 'active',
    };

    test('parses the API shape', () {
      final Student student = Student.fromJson(json);
      expect(student.matricNumber, '2022/248400');
      expect(student.fullName, 'Chidera Okonkwo');
      expect(student.status, 'active');
    });

    test('derives initials', () {
      expect(Student.fromJson(json).initials, 'CO');
      expect(Student.fromJson(<String, dynamic>{...json, 'full_name': 'Ada'}).initials, 'AD');
      expect(
        Student.fromJson(<String, dynamic>{...json, 'full_name': 'Ngozi Chinwe Adeyemi'}).initials,
        'NA',
      );
    });
  });

  group('FeeItem', () {
    Map<String, dynamic> fee(String status) => <String, dynamic>{
          'fee_item_id': 1,
          'name': 'School Fees',
          'category': 'Tuition',
          'amount': '68500.00',
          'amount_formatted': '₦68,500.00',
          'session': '2025/2026',
          'payment_status': status,
          'unn_reference': null,
          'paid_at': null,
        };

    test('maps every payment status the API can send', () {
      expect(FeeItem.fromJson(fee('paid')).status, FeeStatus.paid);
      expect(FeeItem.fromJson(fee('pending')).status, FeeStatus.pending);
      expect(FeeItem.fromJson(fee('under_review')).status, FeeStatus.underReview);
      expect(FeeItem.fromJson(fee('outstanding')).status, FeeStatus.outstanding);
    });

    test('treats an unrecognised status as outstanding, never as paid', () {
      // Failing safe matters here: showing a fee as paid when it is not would
      // stop a student paying it.
      expect(FeeItem.fromJson(fee('something_new')).status, FeeStatus.outstanding);
    });

    test('keeps the amount as the string the server sent', () {
      expect(FeeItem.fromJson(fee('outstanding')).amount, '68500.00');
    });
  });

  group('FeeList', () {
    test('parses the list and the total outstanding', () {
      final FeeList fees = FeeList.fromJson(<String, dynamic>{
        'items': <dynamic>[
          <String, dynamic>{
            'fee_item_id': 1,
            'name': 'School Fees',
            'category': 'Tuition',
            'amount': '68500.00',
            'session': '2025/2026',
            'payment_status': 'outstanding',
          },
        ],
        'total_outstanding': '68500.00',
        'total_outstanding_formatted': '₦68,500.00',
      });

      expect(fees.items, hasLength(1));
      expect(fees.totalOutstandingFormatted, '₦68,500.00');
      expect(fees.hasUnderReview, isFalse);
    });

    test('flags an under review fee, which drives the persistent home banner', () {
      final FeeList fees = FeeList.fromJson(<String, dynamic>{
        'items': <dynamic>[
          <String, dynamic>{
            'fee_item_id': 1,
            'name': 'School Fees',
            'category': 'Tuition',
            'amount': '68500.00',
            'session': '2025/2026',
            'payment_status': 'under_review',
          },
        ],
        'total_outstanding': '68500.00',
      });

      expect(fees.hasUnderReview, isTrue);
    });
  });

  group('Payment', () {
    Map<String, dynamic> payment({
      String status = 'Pending',
      String? expiresAt,
      String? amountPaid,
      bool accountPending = false,
    }) =>
        <String, dynamic>{
          'unn_reference': 'UNN250880118774',
          'status': status,
          'expected_amount': '68500.00',
          'expected_amount_formatted': '₦68,500.00',
          'amount_paid': amountPaid,
          'amount_paid_formatted': amountPaid == null ? null : '₦60,000.00',
          'virtual_account_number': accountPending ? null : '9012345678',
          'virtual_account_bank': accountPending ? null : 'Sandbox Bank',
          'virtual_account_pending': accountPending,
          'channels': <dynamic>['transfer', 'ussd'],
          'expires_at': expiresAt ??
              DateTime.now().toUtc().add(const Duration(hours: 5)).toIso8601String(),
          'paid_at': null,
          'fee_item': <String, dynamic>{'fee_item_id': 1, 'name': 'School Fees'},
          'receipt': null,
        };

    test('parses a pending payment', () {
      final Payment p = Payment.fromJson(payment());
      expect(p.reference, 'UNN250880118774');
      expect(p.isPending, isTrue);
      expect(p.isSettled, isFalse);
      expect(p.virtualAccountNumber, '9012345678');
      expect(p.channels, <String>['transfer', 'ussd']);
      expect(p.feeItemName, 'School Fees');
    });

    test('recognises a settled payment and its receipt', () {
      final Map<String, dynamic> json = payment(status: 'Successful', amountPaid: '68500.00');
      json['receipt'] = <String, dynamic>{
        'receipt_number': 'UNN/2025-2026/000001',
        'verification_code': 'UNN-ABCD-2345',
        'issued_at': DateTime.utc(2025, 8, 15, 10, 30).toIso8601String(),
      };

      final Payment p = Payment.fromJson(json);
      expect(p.isSettled, isTrue);
      expect(p.receipt!.receiptNumber, 'UNN/2025-2026/000001');
      expect(p.receipt!.verificationCode, 'UNN-ABCD-2345');
    });

    test('recognises a payment that needs attention', () {
      final Payment p = Payment.fromJson(payment(status: 'UnderReview', amountPaid: '60000.00'));
      expect(p.needsAttention, isTrue);
      expect(p.isSettled, isFalse);
      expect(p.amountPaidFormatted, '₦60,000.00');
    });

    test('treats a pending payment past its expiry as expired', () {
      final Payment p = Payment.fromJson(
        payment(expiresAt: DateTime.now().toUtc().subtract(const Duration(minutes: 1)).toIso8601String()),
      );
      expect(p.isExpired, isTrue);
    });

    test('does not treat a settled payment as expired, whatever the clock says', () {
      final Payment p = Payment.fromJson(
        payment(
          status: 'Successful',
          amountPaid: '68500.00',
          expiresAt: DateTime.now().toUtc().subtract(const Duration(days: 3)).toIso8601String(),
        ),
      );
      expect(p.isExpired, isFalse);
      expect(p.isSettled, isTrue);
    });

    test('reports an account still being minted after a bank outage', () {
      final Payment p = Payment.fromJson(payment(accountPending: true));
      expect(p.virtualAccountPending, isTrue);
      expect(p.virtualAccountNumber, isNull);
      // The reference is still valid and usable.
      expect(p.reference, 'UNN250880118774');
    });

    test('reports the time remaining', () {
      final Payment p = Payment.fromJson(
        payment(expiresAt: DateTime.now().toUtc().add(const Duration(hours: 2)).toIso8601String()),
      );
      expect(p.timeRemaining.inMinutes, greaterThan(115));
      expect(p.timeRemaining.inMinutes, lessThanOrEqualTo(120));
    });
  });
}
