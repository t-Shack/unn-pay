import 'dart:math';

import 'package:flutter/material.dart';

import '../models/models.dart';
import '../services/api_client.dart';
import '../services/app_state.dart';
import '../theme/theme.dart';
import '../widgets/common.dart' as ui;
import 'history_screen.dart';
import 'payment_screen.dart';

/// Home: what this student owes, and one tap to pay any of it.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.state});

  final AppState state;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int? _starting;

  AppState get state => widget.state;

  @override
  void initState() {
    super.initState();
    // A push arriving while the app is open should update what is on screen.
    state.push?.lastMessage.addListener(_onPush);
  }

  @override
  void dispose() {
    state.push?.lastMessage.removeListener(_onPush);
    super.dispose();
  }

  void _onPush() {
    if (mounted) state.refreshFees();
  }

  /// Start a payment.
  ///
  /// The idempotency key is derived from the student, the fee item and the
  /// current minute, so a double tap or a retry after a dropped response
  /// returns the reference already minted rather than a second one (§9.1).
  Future<void> _pay(FeeItem fee) async {
    setState(() => _starting = fee.feeItemId);

    final String key = 'pay-${state.student!.studentId}-${fee.feeItemId}-'
        '${DateTime.now().millisecondsSinceEpoch ~/ 60000}';

    try {
      final Map<String, dynamic> response =
          await state.api.initiatePayment(fee.feeItemId, idempotencyKey: key);
      if (!mounted) return;

      final Payment payment = Payment.fromJson(response['payment'] as Map<String, dynamic>);

      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => PaymentScreen(state: state, payment: payment),
        ),
      );
      await state.refreshFees();
    } on ApiException catch (error) {
      if (!mounted) return;
      _explain(error);
    } finally {
      if (mounted) setState(() => _starting = null);
    }
  }

  void _explain(ApiException error) {
    final String message = switch (error.code) {
      'fee_already_paid' => 'You have already paid this fee. Check your payment history.',
      'fee_under_review' =>
        'A payment for this fee is being reviewed by the Bursary. Please visit them before '
            'paying again, so you are not charged twice.',
      'bank_circuit_open' || 'bank_unavailable' =>
        'The bank is not responding right now. Please try again in a minute — nothing has been '
            'charged.',
      _ => error.message,
    };

    showDialog<void>(
      context: context,
      builder: (BuildContext context) => AlertDialog(
        title: const Text('Cannot start this payment'),
        content: Text(message),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Close'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final Student student = state.student!;
    final FeeList? fees = state.fees;

    return Scaffold(
      appBar: AppBar(
        titleSpacing: 16,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              _greeting(student.fullName),
              style: const TextStyle(fontSize: 16.5, fontWeight: FontWeight.w700),
            ),
            Text(
              '${student.matricNumber} · ${student.department}',
              style: const TextStyle(fontSize: 12, color: UnnTheme.muted),
            ),
          ],
        ),
        actions: <Widget>[
          IconButton(
            tooltip: 'Payment history',
            icon: const Icon(Icons.receipt_long_rounded),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => HistoryScreen(state: state)),
            ),
          ),
          PopupMenuButton<String>(
            onSelected: (String value) {
              if (value == 'signout') _confirmSignOut();
            },
            itemBuilder: (BuildContext context) => <PopupMenuEntry<String>>[
              PopupMenuItem<String>(
                enabled: false,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(student.fullName, style: const TextStyle(fontWeight: FontWeight.w600)),
                    Text(
                      student.email,
                      style: const TextStyle(fontSize: 12, color: UnnTheme.muted),
                    ),
                  ],
                ),
              ),
              const PopupMenuDivider(),
              const PopupMenuItem<String>(value: 'signout', child: Text('Sign out')),
            ],
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: state.refreshFees,
        child: fees == null
            ? (state.error != null
                ? ui.ErrorView(message: state.error!, onRetry: state.refreshFees)
                : const Center(child: CircularProgressIndicator()))
            : ListView(
                padding: const EdgeInsets.all(16),
                children: <Widget>[
                  // A payment under review is a persistent banner until it is
                  // resolved (§10.5) — the student must not miss it.
                  if (fees.hasUnderReview) ...<Widget>[
                    const ui.NoticeBanner(
                      title: 'A payment needs your attention',
                      message:
                          'One of your payments could not be applied automatically. Your money is '
                          'safe and recorded. Please visit the Bursary to have it resolved.',
                    ),
                    const SizedBox(height: 14),
                  ],
                  _outstandingCard(fees),
                  const SizedBox(height: 18),
                  const Padding(
                    padding: EdgeInsets.only(left: 4, bottom: 8),
                    child: Text(
                      'YOUR FEES',
                      style: TextStyle(
                        fontSize: 11.5,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.8,
                        color: UnnTheme.muted,
                      ),
                    ),
                  ),
                  if (fees.items.isEmpty)
                    const Card(
                      child: Padding(
                        padding: EdgeInsets.all(28),
                        child: ui.EmptyState(
                          icon: Icons.inbox_rounded,
                          title: 'No fees right now',
                          message:
                              'The Bursary has not published any fees for your department and '
                              'level this session.',
                        ),
                      ),
                    )
                  else
                    ...fees.items.map(_feeCard),
                  const SizedBox(height: 24),
                ],
              ),
      ),
    );
  }

  Widget _outstandingCard(FeeList fees) {
    return Card(
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          gradient: const LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: <Color>[UnnTheme.green, UnnTheme.greenDark],
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            const Text(
              'TOTAL OUTSTANDING',
              style: TextStyle(
                color: Colors.white70,
                fontSize: 11.5,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.8,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              fees.totalOutstandingFormatted,
              style: const TextStyle(
                color: Colors.white,
                fontSize: 33,
                fontWeight: FontWeight.w700,
                letterSpacing: -1,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              fees.items.where((FeeItem f) => f.status != FeeStatus.paid).isEmpty
                  ? 'Everything is paid. Well done.'
                  : '${fees.items.where((FeeItem f) => f.status != FeeStatus.paid).length} fee(s) still to pay',
              style: const TextStyle(color: Colors.white70, fontSize: 13),
            ),
          ],
        ),
      ),
    );
  }

  Widget _feeCard(FeeItem fee) {
    final (String label, ui.StatusTone tone) = switch (fee.status) {
      FeeStatus.paid => ('Paid', ui.StatusTone.good),
      FeeStatus.pending => ('Awaiting payment', ui.StatusTone.neutral),
      FeeStatus.underReview => ('Under review', ui.StatusTone.warning),
      FeeStatus.outstanding => ('Outstanding', ui.StatusTone.neutral),
    };

    final bool payable =
        fee.status == FeeStatus.outstanding || fee.status == FeeStatus.pending;
    final bool busy = _starting == fee.feeItemId;

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          fee.name,
                          style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600),
                        ),
                        const SizedBox(height: 3),
                        Text(
                          '${fee.category} · ${fee.session}',
                          style: const TextStyle(fontSize: 12.5, color: UnnTheme.muted),
                        ),
                      ],
                    ),
                  ),
                  ui.StatusChip(label: label, tone: tone),
                ],
              ),
              const SizedBox(height: 14),
              Row(
                children: <Widget>[
                  Text(
                    fee.amountFormatted,
                    style: const TextStyle(
                      fontSize: 21,
                      fontWeight: FontWeight.w700,
                      letterSpacing: -0.4,
                    ),
                  ),
                  const Spacer(),
                  if (fee.status == FeeStatus.paid && fee.paidAt != null)
                    Text(
                      'Paid ${formatWat(fee.paidAt, withTime: false)}',
                      style: const TextStyle(fontSize: 12, color: UnnTheme.muted),
                    )
                  else if (payable)
                    SizedBox(
                      width: 132,
                      child: FilledButton(
                        onPressed: busy ? null : () => _pay(fee),
                        style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(42)),
                        child: busy
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: Colors.white,
                                ),
                              )
                            : Text(fee.status == FeeStatus.pending ? 'Continue' : 'Pay now'),
                      ),
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _confirmSignOut() async {
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext context) => AlertDialog(
        title: const Text('Sign out?'),
        content: const Text('You will need your matric number and password to sign back in.'),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Sign out'),
          ),
        ],
      ),
    );
    if (confirmed ?? false) await state.signOut();
  }
}

String _greeting(String fullName) {
  final int hour = DateTime.now().toUtc().add(const Duration(hours: 1)).hour;
  final String part = hour < 12
      ? 'Good morning'
      : hour < 17
          ? 'Good afternoon'
          : 'Good evening';
  final String first = fullName.trim().split(RegExp(r'\s+')).first;
  return '$part, ${first.substring(0, min(first.length, 18))}';
}
