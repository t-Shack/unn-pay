import 'package:intl/intl.dart';

/// Wire models.
///
/// Money arrives from the API as a fixed two decimal string and is kept that
/// way. It is never parsed into a double for arithmetic — this app only ever
/// displays amounts, and a double is the one representation guaranteed to be
/// wrong eventually (spec §7).

final NumberFormat _naira = NumberFormat.currency(locale: 'en_NG', symbol: '₦', decimalDigits: 2);

String formatNaira(String? amount) {
  if (amount == null || amount.isEmpty) return '—';
  final double? value = double.tryParse(amount);
  // Formatting only. The authoritative value stays the string from the server.
  return value == null ? amount : _naira.format(value);
}

class Student {
  const Student({
    required this.studentId,
    required this.matricNumber,
    required this.fullName,
    required this.email,
    required this.department,
    required this.level,
    required this.status,
  });

  factory Student.fromJson(Map<String, dynamic> json) => Student(
        studentId: json['student_id'] as int,
        matricNumber: json['matric_number'] as String,
        fullName: json['full_name'] as String,
        email: json['email'] as String,
        department: json['department'] as String,
        level: json['level'] as String,
        status: json['status'] as String,
      );

  final int studentId;
  final String matricNumber;
  final String fullName;
  final String email;
  final String department;
  final String level;
  final String status;

  /// Initials for an avatar, e.g. "Chidera Okonkwo" -> "CO".
  String get initials {
    final List<String> parts =
        fullName.trim().split(RegExp(r'\s+')).where((String p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return '?';
    if (parts.length == 1) {
      return parts.first.substring(0, parts.first.length >= 2 ? 2 : 1).toUpperCase();
    }
    return '${parts.first[0]}${parts.last[0]}'.toUpperCase();
  }
}

enum FeeStatus { paid, pending, underReview, outstanding }

class FeeItem {
  const FeeItem({
    required this.feeItemId,
    required this.name,
    required this.category,
    required this.amount,
    required this.amountFormatted,
    required this.session,
    required this.status,
    this.reference,
    this.paidAt,
  });

  factory FeeItem.fromJson(Map<String, dynamic> json) => FeeItem(
        feeItemId: json['fee_item_id'] as int,
        name: json['name'] as String,
        category: json['category'] as String,
        amount: json['amount'] as String,
        amountFormatted: json['amount_formatted'] as String? ?? formatNaira(json['amount'] as String?),
        session: json['session'] as String,
        status: switch (json['payment_status'] as String?) {
          'paid' => FeeStatus.paid,
          'pending' => FeeStatus.pending,
          'under_review' => FeeStatus.underReview,
          _ => FeeStatus.outstanding,
        },
        reference: json['unn_reference'] as String?,
        paidAt: json['paid_at'] == null ? null : DateTime.parse(json['paid_at'] as String),
      );

  final int feeItemId;
  final String name;
  final String category;
  final String amount;
  final String amountFormatted;
  final String session;
  final FeeStatus status;
  final String? reference;
  final DateTime? paidAt;
}

class FeeList {
  const FeeList({required this.items, required this.totalOutstandingFormatted});

  factory FeeList.fromJson(Map<String, dynamic> json) => FeeList(
        items: (json['items'] as List<dynamic>)
            .map((item) => FeeItem.fromJson(item as Map<String, dynamic>))
            .toList(),
        totalOutstandingFormatted: json['total_outstanding_formatted'] as String? ??
            formatNaira(json['total_outstanding'] as String?),
      );

  final List<FeeItem> items;
  final String totalOutstandingFormatted;

  bool get hasUnderReview => items.any((item) => item.status == FeeStatus.underReview);
}

class Receipt {
  const Receipt({
    required this.receiptNumber,
    required this.verificationCode,
    required this.issuedAt,
  });

  factory Receipt.fromJson(Map<String, dynamic> json) => Receipt(
        receiptNumber: json['receipt_number'] as String,
        verificationCode: json['verification_code'] as String,
        issuedAt: DateTime.parse(json['issued_at'] as String),
      );

  final String receiptNumber;
  final String verificationCode;
  final DateTime issuedAt;
}

class Payment {
  const Payment({
    required this.reference,
    required this.status,
    required this.expectedAmount,
    required this.expectedAmountFormatted,
    required this.expiresAt,
    required this.virtualAccountPending,
    this.amountPaid,
    this.amountPaidFormatted,
    this.virtualAccountNumber,
    this.virtualAccountBank,
    this.channel,
    this.channels = const [],
    this.paidAt,
    this.feeItemName,
    this.receipt,
  });

  factory Payment.fromJson(Map<String, dynamic> json) => Payment(
        reference: json['unn_reference'] as String,
        status: json['status'] as String,
        expectedAmount: json['expected_amount'] as String,
        expectedAmountFormatted: json['expected_amount_formatted'] as String? ??
            formatNaira(json['expected_amount'] as String?),
        amountPaid: json['amount_paid'] as String?,
        amountPaidFormatted: json['amount_paid_formatted'] as String?,
        virtualAccountNumber: json['virtual_account_number'] as String?,
        virtualAccountBank: json['virtual_account_bank'] as String?,
        virtualAccountPending: json['virtual_account_pending'] as bool? ?? false,
        channel: json['channel'] as String?,
        channels: (json['channels'] as List<dynamic>?)?.cast<String>() ?? const [],
        expiresAt: DateTime.parse(json['expires_at'] as String),
        paidAt: json['paid_at'] == null ? null : DateTime.parse(json['paid_at'] as String),
        feeItemName: json['fee_item'] == null
            ? null
            : (json['fee_item'] as Map<String, dynamic>)['name'] as String?,
        receipt: json['receipt'] == null
            ? null
            : Receipt.fromJson(json['receipt'] as Map<String, dynamic>),
      );

  final String reference;
  final String status;
  final String expectedAmount;
  final String expectedAmountFormatted;
  final String? amountPaid;
  final String? amountPaidFormatted;
  final String? virtualAccountNumber;
  final String? virtualAccountBank;
  final bool virtualAccountPending;
  final String? channel;
  final List<String> channels;
  final DateTime expiresAt;
  final DateTime? paidAt;
  final String? feeItemName;
  final Receipt? receipt;

  bool get isSettled => status == 'Successful';
  bool get isPending => status == 'Pending';
  bool get needsAttention => status == 'UnderReview';
  bool get isExpired => status == 'Expired' || (isPending && DateTime.now().isAfter(expiresAt));

  Duration get timeRemaining => expiresAt.difference(DateTime.now());
}

/// Times are stored in UTC and shown to students in West Africa Time (§3.1).
String formatWat(DateTime? value, {bool withTime = true}) {
  if (value == null) return '—';
  // WAT is UTC+1 year round; Nigeria observes no daylight saving.
  final DateTime wat = value.toUtc().add(const Duration(hours: 1));
  final String date = DateFormat('d MMM yyyy').format(wat);
  return withTime ? '$date, ${DateFormat('HH:mm').format(wat)} WAT' : date;
}
