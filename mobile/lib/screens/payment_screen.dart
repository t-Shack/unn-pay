import 'dart:async';

import 'package:flutter/material.dart';

import '../config.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../services/app_state.dart';
import '../theme/theme.dart';
import '../widgets/common.dart' as ui;
import 'receipt_screen.dart';

/// The payment screen.
///
/// This is where a student sits with their banking app open in the other hand,
/// so it has one job: show the account number, the exact amount, and the
/// reference, large and copyable, and then tell them the moment the money lands.
///
/// It polls every ten seconds while open (§11.3) as a complement to push, since
/// a student who denied notification permission must still see their payment
/// confirm. Polling stops as soon as the payment reaches a final state, and
/// while the app is backgrounded.
class PaymentScreen extends StatefulWidget {
  const PaymentScreen({super.key, required this.state, required this.payment});

  final AppState state;
  final Payment payment;

  @override
  State<PaymentScreen> createState() => _PaymentScreenState();
}

class _PaymentScreenState extends State<PaymentScreen> with WidgetsBindingObserver {
  late Payment _payment;
  Timer? _poll;
  Timer? _countdown;
  String? _error;
  bool _checking = false;

  @override
  void initState() {
    super.initState();
    _payment = widget.payment;
    WidgetsBinding.instance.addObserver(this);
    _startPolling();
    _countdown = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _poll?.cancel();
    _countdown?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // No point polling a screen nobody is looking at.
    if (state == AppLifecycleState.resumed) {
      _refresh();
      _startPolling();
    } else {
      _poll?.cancel();
    }
  }

  void _startPolling() {
    _poll?.cancel();
    if (_isFinal) return;
    _poll = Timer.periodic(AppConfig.pollInterval, (_) => _refresh());
  }

  bool get _isFinal =>
      _payment.isSettled || _payment.needsAttention || _payment.status == 'Failed';

  Future<void> _refresh({bool manual = false}) async {
    if (manual) setState(() => _checking = true);
    try {
      final Map<String, dynamic> response = await widget.state.api.payment(_payment.reference);
      if (!mounted) return;

      final Payment updated = Payment.fromJson(response['payment'] as Map<String, dynamic>);
      final bool justSettled = !_payment.isSettled && updated.isSettled;

      setState(() {
        _payment = updated;
        _error = null;
      });

      if (_isFinal) {
        _poll?.cancel();
        // The fee list on the home screen is now out of date.
        unawaited(widget.state.refreshFees());
      }

      if (justSettled && mounted) {
        ScaffoldMessenger.of(context)
          ..clearSnackBars()
          ..showSnackBar(
            const SnackBar(
              backgroundColor: UnnTheme.green,
              content: Text('Payment received. Your receipt is ready.'),
            ),
          );
      }
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted && manual) setState(() => _checking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Make payment'),
        actions: <Widget>[
          IconButton(
            tooltip: 'Check now',
            onPressed: _checking ? null : () => _refresh(manual: true),
            icon: _checking
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => _refresh(manual: true),
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: <Widget>[
            if (_error != null) ...<Widget>[
              ui.NoticeBanner(message: _error!, tone: ui.StatusTone.danger),
              const SizedBox(height: 14),
            ],
            _statusCard(),
            const SizedBox(height: 14),
            if (_payment.isSettled)
              _settled()
            else if (_payment.needsAttention)
              _underReview()
            else if (_payment.status == 'Failed')
              const ui.NoticeBanner(
                title: 'This payment did not go through',
                message:
                    'No money was taken. You can start the payment again from the home screen.',
                tone: ui.StatusTone.danger,
              )
            else if (_payment.isExpired)
              const ui.NoticeBanner(
                title: 'This reference has expired',
                message:
                    'Do not pay to this account number. Start the payment again to get a fresh '
                    'reference and account number. If you have already paid, contact the Bursary '
                    'and quote this reference — your money is recorded and will be applied.',
                tone: ui.StatusTone.danger,
              )
            else
              _instructions(),
          ],
        ),
      ),
    );
  }

  Widget _statusCard() {
    final (String label, ui.StatusTone tone, IconData icon) = switch (_payment) {
      final Payment p when p.isSettled => ('Paid in full', ui.StatusTone.good, Icons.check_circle),
      final Payment p when p.needsAttention =>
        ('Needs attention', ui.StatusTone.warning, Icons.error_outline),
      final Payment p when p.status == 'Failed' => ('Failed', ui.StatusTone.danger, Icons.cancel),
      final Payment p when p.isExpired => ('Expired', ui.StatusTone.danger, Icons.timer_off),
      _ => ('Waiting for your payment', ui.StatusTone.neutral, Icons.hourglass_empty),
    };

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Icon(icon, size: 20, color: UnnTheme.muted),
                const SizedBox(width: 8),
                ui.StatusChip(label: label, tone: tone),
              ],
            ),
            const SizedBox(height: 16),
            Text(
              _payment.feeItemName ?? 'Fee payment',
              style: const TextStyle(fontSize: 14.5, color: UnnTheme.muted),
            ),
            const SizedBox(height: 4),
            Text(
              _payment.expectedAmountFormatted,
              style: const TextStyle(
                fontSize: 32,
                fontWeight: FontWeight.w700,
                letterSpacing: -0.8,
              ),
            ),
            if (_payment.isPending && !_payment.isExpired) ...<Widget>[
              const SizedBox(height: 12),
              Row(
                children: <Widget>[
                  const Icon(Icons.schedule_rounded, size: 15, color: UnnTheme.muted),
                  const SizedBox(width: 6),
                  Text(
                    'Expires in ${_formatRemaining(_payment.timeRemaining)}',
                    style: const TextStyle(fontSize: 13, color: UnnTheme.muted),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _instructions() {
    // The bank was unreachable when this was started, so the account is being
    // minted in the background (§9.4). The reference is already valid.
    if (_payment.virtualAccountPending) {
      return const ui.NoticeBanner(
        title: 'Your payment reference is being generated',
        message:
            'We are setting up your payment account now. This usually takes less than a minute, '
            'and we will notify you the moment it is ready. You can close the app; nothing is lost.',
        tone: ui.StatusTone.warning,
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Card(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              const Padding(
                padding: EdgeInsets.fromLTRB(16, 16, 16, 4),
                child: Text(
                  'Transfer to this account',
                  style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700),
                ),
              ),
              const Padding(
                padding: EdgeInsets.fromLTRB(16, 0, 16, 10),
                child: Text(
                  'This account belongs to the University and is for this payment only.',
                  style: TextStyle(fontSize: 13, color: UnnTheme.muted, height: 1.4),
                ),
              ),
              const Divider(),
              ui.CopyableValue(
                label: 'Account number',
                value: _payment.virtualAccountNumber ?? '—',
                emphasis: true,
              ),
              const Divider(),
              ui.CopyableValue(label: 'Bank', value: _payment.virtualAccountBank ?? '—'),
              const Divider(),
              ui.CopyableValue(
                label: 'Exact amount to send',
                value: _payment.expectedAmountFormatted,
                emphasis: true,
              ),
              const Divider(),
              ui.CopyableValue(label: 'Payment reference', value: _payment.reference),
            ],
          ),
        ),
        const SizedBox(height: 14),
        const ui.NoticeBanner(
          title: 'Send the exact amount',
          message:
              'If you send more or less than the amount shown, your payment cannot be applied '
              'automatically and you will need to visit the Bursary to sort it out. Your money is '
              'never lost, but it will delay your receipt.',
        ),
        const SizedBox(height: 14),
        if (_payment.channels.isNotEmpty) _channels(),
        const SizedBox(height: 14),
        const Padding(
          padding: EdgeInsets.symmetric(horizontal: 4),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Icon(Icons.autorenew_rounded, size: 16, color: UnnTheme.muted),
              SizedBox(width: 8),
              Expanded(
                child: Text(
                  'This screen updates itself. You can close the app once you have paid — we will '
                  'notify you when the money arrives.',
                  style: TextStyle(fontSize: 12.5, color: UnnTheme.muted, height: 1.5),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _channels() {
    const Map<String, (String, IconData)> labels = <String, (String, IconData)>{
      'transfer': ('Bank transfer', Icons.account_balance_rounded),
      'ussd': ('USSD', Icons.dialpad_rounded),
      'card': ('Card', Icons.credit_card_rounded),
      'pos': ('POS terminal', Icons.point_of_sale_rounded),
      'bank_branch': ('Bank branch', Icons.storefront_rounded),
    };

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            const Text(
              'You can pay any of these ways',
              style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 4),
            const Text(
              'Every method uses the same account number and reference.',
              style: TextStyle(fontSize: 12.5, color: UnnTheme.muted),
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: _payment.channels.map((String channel) {
                final (String label, IconData icon) =
                    labels[channel] ?? (channel, Icons.payments_rounded);
                return Container(
                  padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
                  decoration: BoxDecoration(
                    border: Border.all(color: UnnTheme.line),
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Icon(icon, size: 15, color: UnnTheme.muted),
                      const SizedBox(width: 6),
                      Text(label, style: const TextStyle(fontSize: 13)),
                    ],
                  ),
                );
              }).toList(),
            ),
          ],
        ),
      ),
    );
  }

  Widget _settled() {
    return Column(
      children: <Widget>[
        const ui.NoticeBanner(
          title: 'Payment received',
          message: 'Your payment has been applied in full and your receipt is ready.',
          tone: ui.StatusTone.good,
        ),
        const SizedBox(height: 14),
        Card(
          child: Column(
            children: <Widget>[
              ui.CopyableValue(label: 'Paid', value: _payment.amountPaidFormatted ?? '—'),
              const Divider(),
              ui.CopyableValue(label: 'Reference', value: _payment.reference),
              if (_payment.receipt != null) ...<Widget>[
                const Divider(),
                ui.CopyableValue(
                  label: 'Receipt number',
                  value: _payment.receipt!.receiptNumber,
                ),
              ],
              const Divider(),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                child: Row(
                  children: <Widget>[
                    const Text('Paid on', style: TextStyle(color: UnnTheme.muted, fontSize: 12)),
                    const Spacer(),
                    Text(
                      formatWat(_payment.paidAt),
                      style: const TextStyle(fontWeight: FontWeight.w600),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        FilledButton.icon(
          onPressed: () => Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) => ReceiptScreen(state: widget.state, payment: _payment),
            ),
          ),
          icon: const Icon(Icons.receipt_long_rounded),
          label: const Text('View receipt'),
        ),
      ],
    );
  }

  Widget _underReview() {
    return Column(
      children: <Widget>[
        ui.NoticeBanner(
          title: 'Your payment needs attention',
          tone: ui.StatusTone.warning,
          message:
              'We received ${_payment.amountPaidFormatted ?? 'your payment'}, but it does not match '
              'the ${_payment.expectedAmountFormatted} expected for this fee, so it could not be '
              'applied automatically.\n\n'
              'Your money has not been lost. It is recorded against your name. Please visit the '
              'Bursary with this reference to have it resolved. No receipt is issued until then.',
        ),
        const SizedBox(height: 14),
        Card(
          child: Column(
            children: <Widget>[
              ui.CopyableValue(label: 'Amount received', value: _payment.amountPaidFormatted ?? '—'),
              const Divider(),
              ui.CopyableValue(label: 'Amount expected', value: _payment.expectedAmountFormatted),
              const Divider(),
              ui.CopyableValue(label: 'Reference to quote', value: _payment.reference),
            ],
          ),
        ),
      ],
    );
  }
}

String _formatRemaining(Duration duration) {
  if (duration.isNegative) return 'expired';
  final int hours = duration.inHours;
  final int minutes = duration.inMinutes.remainder(60);
  final int seconds = duration.inSeconds.remainder(60);
  if (hours > 0) return '${hours}h ${minutes}m';
  if (minutes > 0) return '${minutes}m ${seconds}s';
  return '${seconds}s';
}
