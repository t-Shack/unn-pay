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

class _PaymentScreenState extends State<PaymentScreen>
    with WidgetsBindingObserver {
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
      _payment.isSettled ||
      _payment.needsAttention ||
      _payment.status == 'Failed';

  Future<void> _refresh({bool manual = false}) async {
    if (manual) setState(() => _checking = true);
    try {
      final Map<String, dynamic> response =
          await widget.state.api.payment(_payment.reference);
      if (!mounted) return;

      final Payment updated =
          Payment.fromJson(response['payment'] as Map<String, dynamic>);
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
      appBar: ui.ScreenHeader(
        title: _payment.isSettled ? 'Payment received' : 'Make payment',
        actions: <Widget>[
          if (_checking)
            const SizedBox(
              width: 44,
              height: 44,
              child: Padding(
                padding: EdgeInsets.all(12),
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            )
          else
            ui.HeaderButton(
              icon: Icons.refresh_rounded,
              tooltip: 'Check now',
              onPressed: () => _refresh(manual: true),
            ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => _refresh(manual: true),
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 28),
          children: <Widget>[
            if (_error != null) ...<Widget>[
              ui.NoticeBanner(message: _error!, tone: ui.StatusTone.danger),
              const SizedBox(height: 14),
            ],
            if (_payment.isSettled)
              _settled()
            else ...<Widget>[
              _summary(),
              const SizedBox(height: 14),
              if (_payment.needsAttention)
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
          ],
        ),
      ),
    );
  }

  /// The fee, the amount, and where the payment stands.
  Widget _summary() {
    final bool live = _payment.isPending && !_payment.isExpired;

    final (String label, Color dot) = switch (_payment) {
      final Payment p when p.needsAttention => (
          'Needs attention',
          const Color(0xFFEA580C)
        ),
      final Payment p when p.status == 'Failed' => (
          'Payment failed',
          UnnTheme.red
        ),
      final Payment p when p.isExpired => ('Reference expired', UnnTheme.muted),
      _ => ('Waiting for your transfer', UnnTheme.gold),
    };

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: <Widget>[
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    _payment.feeItemName ?? 'Fee payment',
                    style: const TextStyle(
                      fontSize: 13.5,
                      fontWeight: FontWeight.w600,
                      color: UnnTheme.muted,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    _payment.expectedAmountFormatted,
                    style: const TextStyle(
                      fontSize: 34,
                      fontWeight: FontWeight.w800,
                      letterSpacing: -1.1,
                      fontFeatures: UnnTheme.tabular,
                    ),
                  ),
                ],
              ),
            ),
            if (live)
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                decoration: BoxDecoration(
                  color: UnnTheme.goldSoft,
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Column(
                  children: <Widget>[
                    const Text(
                      'EXPIRES IN',
                      style: TextStyle(
                        fontSize: 10.5,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.4,
                        color: UnnTheme.amber,
                      ),
                    ),
                    Text(
                      _clock(_payment.timeRemaining),
                      style:
                          UnnTheme.monoStyle(size: 15, color: UnnTheme.amber),
                    ),
                  ],
                ),
              ),
          ],
        ),
        const SizedBox(height: 14),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(14),
          ),
          child: Row(
            children: <Widget>[
              Container(
                width: 10,
                height: 10,
                decoration: BoxDecoration(
                  color: dot,
                  shape: BoxShape.circle,
                  boxShadow: <BoxShadow>[
                    BoxShadow(
                        color: dot.withValues(alpha: 0.3), spreadRadius: 4,),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  label,
                  style: const TextStyle(
                      fontSize: 13.5, fontWeight: FontWeight.w700,),
                ),
              ),
              if (live)
                const Text(
                  'Updates automatically',
                  style: TextStyle(fontSize: 12, color: UnnTheme.muted),
                ),
            ],
          ),
        ),
      ],
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

    final String account = _payment.virtualAccountNumber ?? '—';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        ui.ForestCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Row(
                children: <Widget>[
                  Container(
                    width: 36,
                    height: 36,
                    decoration: BoxDecoration(
                      color: Colors.white.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(11),
                    ),
                    child: const Icon(Icons.account_balance_outlined,
                        color: Colors.white, size: 19,),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        const Text(
                          'Transfer to',
                          style: TextStyle(
                            fontSize: 11.5,
                            fontWeight: FontWeight.w600,
                            color: UnnTheme.onForestMuted,
                          ),
                        ),
                        Text(
                          _payment.virtualAccountBank ?? '—',
                          style: const TextStyle(
                              fontSize: 14, fontWeight: FontWeight.w700,),
                        ),
                      ],
                    ),
                  ),
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
                    decoration: BoxDecoration(
                      color: UnnTheme.gold.withValues(alpha: 0.18),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: const Text(
                      'This payment only',
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                        color: UnnTheme.gold,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 18),
              const Text(
                'Account number',
                style: TextStyle(
                  fontSize: 11.5,
                  fontWeight: FontWeight.w600,
                  color: UnnTheme.onForestMuted,
                ),
              ),
              const SizedBox(height: 4),
              Row(
                children: <Widget>[
                  Expanded(
                    child: FittedBox(
                      fit: BoxFit.scaleDown,
                      alignment: Alignment.centerLeft,
                      child: Text(
                        _groupDigits(account),
                        style: UnnTheme.monoStyle(size: 28, color: Colors.white)
                            .copyWith(letterSpacing: 1),
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  FilledButton.icon(
                    onPressed: account == '—'
                        ? null
                        : () => ui.copyToClipboard(
                            context, 'Account number', account,),
                    style: FilledButton.styleFrom(
                      backgroundColor: UnnTheme.gold,
                      foregroundColor: UnnTheme.forest,
                      minimumSize: const Size(0, 44),
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(14),),
                      textStyle: const TextStyle(
                        fontFamily: UnnTheme.font,
                        fontSize: 13.5,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    icon: const Icon(Icons.copy_rounded, size: 16),
                    label: const Text('Copy'),
                  ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        Card(
          clipBehavior: Clip.antiAlias,
          child: Column(
            children: <Widget>[
              ui.CopyableValue(
                label: 'Exact amount to send',
                value: _payment.expectedAmountFormatted,
                emphasis: true,
              ),
              const Divider(),
              ui.CopyableValue(
                  label: 'Payment reference',
                  value: _payment.reference,
                  mono: true,),
            ],
          ),
        ),
        const SizedBox(height: 12),
        const ui.NoticeBanner(
          title: 'Send the exact amount',
          message:
              'If you send more or less than the amount shown, your payment cannot be applied '
              'automatically and you will need to visit the Bursary to sort it out. Your money is '
              'never lost, but it will delay your receipt.',
        ),
        if (_payment.channels.isNotEmpty) ...<Widget>[
          const SizedBox(height: 16),
          _channels(),
        ],
        const SizedBox(height: 16),
        const Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Icon(Icons.autorenew_rounded, size: 16, color: UnnTheme.muted),
            SizedBox(width: 8),
            Expanded(
              child: Text(
                'This screen updates itself. You can close the app once you have paid — we will '
                'notify you when the money arrives.',
                style: TextStyle(
                    fontSize: 12.5, color: UnnTheme.muted, height: 1.5,),
              ),
            ),
          ],
        ),
      ],
    );
  }

  Widget _channels() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        const Text(
          'You can pay any of these ways',
          style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 2),
        const Text(
          'Every method uses the same account number and reference.',
          style: TextStyle(fontSize: 12.5, color: UnnTheme.muted),
        ),
        const SizedBox(height: 10),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: _payment.channels.map((String channel) {
            final (String label, IconData icon) = channelInfo(channel);
            return Container(
              padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
              decoration: BoxDecoration(
                color: Colors.white,
                border: Border.all(color: UnnTheme.line),
                borderRadius: BorderRadius.circular(999),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Icon(icon, size: 15, color: UnnTheme.green),
                  const SizedBox(width: 6),
                  Text(label,
                      style: const TextStyle(
                          fontSize: 12.5, fontWeight: FontWeight.w600,),),
                ],
              ),
            );
          }).toList(),
        ),
      ],
    );
  }

  Widget _settled() {
    final String amount =
        _payment.amountPaidFormatted ?? _payment.expectedAmountFormatted;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        ui.ForestCard(
          ringSize: 220,
          padding: const EdgeInsets.fromLTRB(20, 28, 20, 26),
          child: Column(
            children: <Widget>[
              Container(
                width: 132,
                height: 132,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: UnnTheme.gold.withValues(alpha: 0.12),
                  border:
                      Border.all(color: UnnTheme.gold.withValues(alpha: 0.25)),
                ),
                child: Container(
                  width: 80,
                  height: 80,
                  decoration: const BoxDecoration(
                      color: UnnTheme.gold, shape: BoxShape.circle,),
                  child: const Icon(
                    Icons.check_rounded,
                    size: 44,
                    color: UnnTheme.forest,
                    semanticLabel: 'Success',
                  ),
                ),
              ),
              const SizedBox(height: 16),
              const Text(
                'PAYMENT RECEIVED',
                style: TextStyle(
                  fontSize: 13.5,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.6,
                  color: UnnTheme.gold,
                ),
              ),
              const SizedBox(height: 6),
              FittedBox(
                fit: BoxFit.scaleDown,
                child: Text(
                  amount,
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 40,
                    fontWeight: FontWeight.w800,
                    letterSpacing: -1.4,
                    fontFeatures: UnnTheme.tabular,
                  ),
                ),
              ),
              const SizedBox(height: 6),
              Text(
                '${_payment.feeItemName ?? 'This fee'} is fully paid.\nYour receipt is ready.',
                textAlign: TextAlign.center,
                style: const TextStyle(
                    color: UnnTheme.onForestMuted, fontSize: 14, height: 1.5,),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        Card(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 4),
            child: Column(
              children: <Widget>[
                if (_payment.receipt != null)
                  ui.DetailRow(
                    label: 'Receipt number',
                    value: _payment.receipt!.receiptNumber,
                    mono: true,
                  ),
                ui.DetailRow(
                    label: 'Reference', value: _payment.reference, mono: true,),
                ui.DetailRow(
                    label: 'Paid on', value: formatWat(_payment.paidAt),),
                ui.DetailRow(
                  label: 'Paid by',
                  value: channelInfo(_payment.channel ?? 'transfer').$1,
                  last: true,
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 18),
        if (_payment.receipt != null)
          FilledButton.icon(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) =>
                    ReceiptScreen(state: widget.state, payment: _payment),
              ),
            ),
            icon: const Icon(Icons.receipt_long_rounded),
            label: const Text('View receipt'),
          ),
        const SizedBox(height: 6),
        TextButton(
          onPressed: () => Navigator.of(context)
              .popUntil((Route<dynamic> route) => route.isFirst),
          child: const Text('Back to home'),
        ),
      ],
    );
  }

  Widget _underReview() {
    final double received = double.tryParse(_payment.amountPaid ?? '') ?? 0;
    final double expected = double.tryParse(_payment.expectedAmount) ?? 0;
    final double difference = received - expected;
    final double scale = received > expected ? received : expected;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Container(
          padding: const EdgeInsets.all(18),
          decoration: BoxDecoration(
            color: UnnTheme.goldSoft,
            borderRadius: BorderRadius.circular(22),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              const ui.IconTile(
                icon: Icons.warning_amber_rounded,
                background: UnnTheme.gold,
                foreground: Color(0xFF3D2200),
              ),
              const SizedBox(height: 12),
              const Text(
                'Your payment needs attention',
                style: TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w800,
                  letterSpacing: -0.4,
                  color: Color(0xFF3D2200),
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'We received ${_payment.amountPaidFormatted ?? 'your payment'}, but it does not '
                'match the ${_payment.expectedAmountFormatted} expected for this fee, so it could '
                'not be applied automatically.\n\n'
                'Your money has not been lost. It is recorded against your name. Please visit the '
                'Bursary with this reference to have it resolved. No receipt is issued until then.',
                style: const TextStyle(
                    fontSize: 13.5, height: 1.5, color: Color(0xFF5C3200),),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                _compareRow(
                  'Amount received',
                  _payment.amountPaidFormatted ?? '—',
                  scale == 0 ? 0 : received / scale,
                  UnnTheme.gold,
                ),
                const SizedBox(height: 14),
                _compareRow(
                  'Amount expected',
                  _payment.expectedAmountFormatted,
                  scale == 0 ? 0 : expected / scale,
                  UnnTheme.green,
                ),
                if (received > 0) ...<Widget>[
                  const SizedBox(height: 14),
                  const Divider(),
                  const SizedBox(height: 12),
                  Row(
                    children: <Widget>[
                      Expanded(
                        child: Text(
                          difference < 0 ? 'Short by' : 'Over by',
                          style: const TextStyle(
                              fontSize: 13, fontWeight: FontWeight.w700,),
                        ),
                      ),
                      Text(
                        formatNaira(difference.abs().toStringAsFixed(2)),
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w800,
                          color: UnnTheme.orange,
                          fontFeatures: UnnTheme.tabular,
                        ),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
        ),
        const SizedBox(height: 12),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                const Text(
                  'What to do next',
                  style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 12),
                _step(1, 'Visit the Bursary with the reference below.',
                    current: true,),
                _step(2, 'They apply it to your fee, or arrange a refund.'),
                _step(3, 'You are notified here the moment it is done.'),
              ],
            ),
          ),
        ),
        const SizedBox(height: 12),
        Card(
          clipBehavior: Clip.antiAlias,
          child: ui.CopyableValue(
            label: 'Reference to quote',
            value: _payment.reference,
            mono: true,
          ),
        ),
      ],
    );
  }

  Widget _compareRow(
      String label, String amount, double fraction, Color color,) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Row(
          children: <Widget>[
            Expanded(
              child: Text(
                label,
                style: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                  color: UnnTheme.muted,
                ),
              ),
            ),
            Text(
              amount,
              style: const TextStyle(
                fontSize: 13.5,
                fontWeight: FontWeight.w800,
                fontFeatures: UnnTheme.tabular,
              ),
            ),
          ],
        ),
        const SizedBox(height: 6),
        ClipRRect(
          borderRadius: BorderRadius.circular(999),
          child: LinearProgressIndicator(
            value: fraction.clamp(0, 1).toDouble(),
            minHeight: 10,
            color: color,
            backgroundColor: UnnTheme.divider,
          ),
        ),
      ],
    );
  }

  Widget _step(int number, String text, {bool current = false}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            width: 26,
            height: 26,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: current ? UnnTheme.green : UnnTheme.mint,
              shape: BoxShape.circle,
            ),
            child: Text(
              '$number',
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w800,
                color: current ? Colors.white : UnnTheme.greenDark,
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Text(text,
                  style: const TextStyle(fontSize: 13, height: 1.45),),
            ),
          ),
        ],
      ),
    );
  }
}

/// A channel's label and icon, shared with the receipt screen.
(String, IconData) channelInfo(String channel) => switch (channel) {
      'transfer' => ('Bank transfer', Icons.account_balance_outlined),
      'ussd' => ('USSD', Icons.dialpad_rounded),
      'card' => ('Card', Icons.credit_card_rounded),
      'pos' => ('POS terminal', Icons.point_of_sale_rounded),
      'bank_branch' => ('Bank branch', Icons.storefront_outlined),
      _ => (channel, Icons.payments_outlined),
    };

/// 9012345678 -> 901 234 5678, the way Nigerian account numbers are read out.
String _groupDigits(String value) {
  if (!RegExp(r'^\d{10}$').hasMatch(value)) return value;
  return '${value.substring(0, 3)} ${value.substring(3, 6)} ${value.substring(6)}';
}

/// A countdown as HH:MM:SS.
String _clock(Duration duration) {
  if (duration.isNegative) return '00:00:00';
  String two(int n) => n.toString().padLeft(2, '0');
  return '${two(duration.inHours)}:${two(duration.inMinutes.remainder(60))}:'
      '${two(duration.inSeconds.remainder(60))}';
}
