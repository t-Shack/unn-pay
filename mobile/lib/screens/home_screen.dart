import 'dart:math';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/models.dart';
import '../services/api_client.dart';
import '../services/app_state.dart';
import '../theme/theme.dart';
import '../widgets/common.dart' as ui;
import 'history_screen.dart';
import 'payment_screen.dart';

/// The tabs the home screen's shortcuts can jump to. Matches [MainShell].
class HomeTab {
  const HomeTab._();
  static const int history = 1;
  static const int receipts = 2;
}

/// Home: what this student owes, and one tap to pay any of it.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.state, this.onOpenTab});

  final AppState state;

  /// Switches the bottom navigation tab. When the screen is shown on its own
  /// (tests, or no shell), the shortcuts push the screen instead.
  final ValueChanged<int>? onOpenTab;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final GlobalKey _feesHeading = GlobalKey();
  int? _starting;
  bool _hideAmounts = false;

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

      final Payment payment =
          Payment.fromJson(response['payment'] as Map<String, dynamic>);

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
      'fee_already_paid' =>
        'You have already paid this fee. Check your payment history.',
      'fee_under_review' =>
        'A payment for this fee is being reviewed by the Bursary. Please visit them before '
            'paying again, so you are not charged twice.',
      'bank_circuit_open' ||
      'bank_unavailable' =>
        'The bank is not responding right now. Please try again in a minute — nothing has been '
            'charged.',
      _ => error.message,
    };

    showDialog<void>(
      context: context,
      builder: (BuildContext context) => AlertDialog(
        title: const Text('Cannot start this payment'),
        content: Text(message, style: const TextStyle(height: 1.5)),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Close'),
          ),
        ],
      ),
    );
  }

  void _openTab(int tab) {
    if (widget.onOpenTab != null) {
      widget.onOpenTab!(tab);
      return;
    }
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) =>
            HistoryScreen(state: state, receiptsOnly: tab == HomeTab.receipts),
      ),
    );
  }

  void _scrollToFees() {
    final BuildContext? target = _feesHeading.currentContext;
    if (target != null) {
      Scrollable.ensureVisible(target,
          duration: const Duration(milliseconds: 350),);
    }
  }

  Future<void> _verifyReceipt() async {
    final TextEditingController code = TextEditingController();
    final String? entered = await showDialog<String>(
      context: context,
      builder: (BuildContext context) => AlertDialog(
        title: const Text('Verify a receipt'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            const Text(
              'Enter the code printed on the receipt. It is checked against the University\'s '
              'own records.',
              style: TextStyle(color: UnnTheme.muted, height: 1.5),
            ),
            const SizedBox(height: 14),
            TextField(
              controller: code,
              autofocus: true,
              textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(hintText: 'UNN-XXXX-XXXX'),
              style: UnnTheme.monoStyle(size: 16),
            ),
          ],
        ),
        actions: <Widget>[
          TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Cancel'),),
          TextButton(
            onPressed: () => Navigator.of(context).pop(code.text.trim()),
            child: const Text('Verify'),
          ),
        ],
      ),
    );
    code.dispose();
    if (entered == null || entered.isEmpty) return;
    await launchUrl(
      Uri.parse('${state.api.baseUrl}/verify/${Uri.encodeComponent(entered)}'),
      mode: LaunchMode.externalApplication,
    );
  }

  @override
  Widget build(BuildContext context) {
    final FeeList? fees = state.fees;

    return Scaffold(
      body: RefreshIndicator(
        onRefresh: state.refreshFees,
        child: fees == null
            ? (state.error != null
                ? ui.ErrorView(
                    message: state.error!, onRetry: state.refreshFees,)
                : const Center(child: CircularProgressIndicator()))
            : ListView(
                padding: EdgeInsets.zero,
                children: <Widget>[
                  _hero(fees),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 20, 20, 28),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: <Widget>[
                        // A payment under review is a persistent banner until it
                        // is resolved (§10.5) — the student must not miss it.
                        if (fees.hasUnderReview) ...<Widget>[
                          const ui.NoticeBanner(
                            title: 'A payment needs your attention',
                            message:
                                'One of your payments could not be applied automatically. Your '
                                'money is safe and recorded. Please visit the Bursary to have it '
                                'resolved.',
                          ),
                          const SizedBox(height: 18),
                        ],
                        Row(
                          key: _feesHeading,
                          crossAxisAlignment: CrossAxisAlignment.baseline,
                          textBaseline: TextBaseline.alphabetic,
                          children: <Widget>[
                            const Expanded(
                              child: Text(
                                'Your fees',
                                style: TextStyle(
                                    fontSize: 17, fontWeight: FontWeight.w800,),
                              ),
                            ),
                            Text(
                              '${fees.items.length} this session',
                              style: const TextStyle(
                                fontSize: 13,
                                fontWeight: FontWeight.w500,
                                color: UnnTheme.muted,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 12),
                        if (fees.items.isEmpty)
                          const Card(
                            child: Padding(
                              padding: EdgeInsets.symmetric(vertical: 12),
                              child: ui.EmptyState(
                                icon: Icons.inbox_rounded,
                                title: 'No fees right now',
                                message:
                                    'The Bursary has not published any fees for your department '
                                    'and level this session.',
                              ),
                            ),
                          )
                        else
                          ...fees.items.map(_feeCard),
                      ],
                    ),
                  ),
                ],
              ),
      ),
    );
  }

  Widget _hero(FeeList fees) {
    final Student student = state.student!;
    final List<FeeItem> paid =
        fees.items.where((FeeItem f) => f.status == FeeStatus.paid).toList();
    final double paidTotal = paid.fold<double>(
        0, (double sum, FeeItem f) => sum + (double.tryParse(f.amount) ?? 0),);
    final double progress =
        fees.items.isEmpty ? 0 : paid.length / fees.items.length;
    final String total = fees.totalOutstandingFormatted;
    final int dot = total.lastIndexOf('.');
    final String session =
        fees.items.isNotEmpty ? fees.items.first.session : '';

    return Container(
      decoration: const BoxDecoration(
        color: UnnTheme.forest,
        borderRadius: BorderRadius.vertical(bottom: Radius.circular(32)),
      ),
      clipBehavior: Clip.antiAlias,
      child: Stack(
        children: <Widget>[
          const Positioned(
              right: -80,
              top: -90,
              child: ui.GoldRing(size: 240, opacity: 0.10),),
          SafeArea(
            bottom: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 22),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      Container(
                        width: 46,
                        height: 46,
                        alignment: Alignment.center,
                        decoration: const BoxDecoration(
                          color: UnnTheme.gold,
                          shape: BoxShape.circle,
                        ),
                        child: Text(
                          student.initials,
                          style: const TextStyle(
                            color: UnnTheme.forest,
                            fontWeight: FontWeight.w800,
                            fontSize: 15,
                          ),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Text(
                              _greeting(student.fullName),
                              style: const TextStyle(
                                color: Colors.white,
                                fontSize: 18,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                            const SizedBox(height: 2),
                            Text(
                              '${student.matricNumber} · ${student.department}',
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                color: UnnTheme.onForestMuted,
                                fontSize: 12.5,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 22),
                  Row(
                    children: <Widget>[
                      const Flexible(
                        child: Text(
                          'Total outstanding',
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: UnnTheme.onForestMuted,
                            fontSize: 13,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ),
                      const SizedBox(width: 4),
                      IconButton(
                        tooltip: _hideAmounts ? 'Show amounts' : 'Hide amounts',
                        visualDensity: VisualDensity.compact,
                        onPressed: () =>
                            setState(() => _hideAmounts = !_hideAmounts),
                        icon: Icon(
                          _hideAmounts
                              ? Icons.visibility_off_outlined
                              : Icons.visibility_outlined,
                          size: 18,
                          color: UnnTheme.onForestMuted,
                        ),
                      ),
                      const Spacer(),
                      if (session.isNotEmpty)
                        Flexible(
                          child: Container(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 10, vertical: 5,),
                            decoration: BoxDecoration(
                              color: Colors.white.withValues(alpha: 0.10),
                              borderRadius: BorderRadius.circular(999),
                            ),
                            child: Text(
                              '$session session',
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                color: Colors.white,
                                fontSize: 12,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                  if (_hideAmounts)
                    const Text(
                      '₦ • • • • •',
                      style: TextStyle(
                        color: Colors.white,
                        fontSize: 40,
                        fontWeight: FontWeight.w800,
                      ),
                    )
                  else
                    Text.rich(
                      TextSpan(
                        text: dot > 0 ? total.substring(0, dot) : total,
                        children: <InlineSpan>[
                          if (dot > 0)
                            TextSpan(
                              text: total.substring(dot),
                              style: TextStyle(
                                fontSize: 22,
                                color: Colors.white.withValues(alpha: 0.6),
                              ),
                            ),
                        ],
                      ),
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 40,
                        height: 1.15,
                        fontWeight: FontWeight.w800,
                        letterSpacing: -1.4,
                        fontFeatures: UnnTheme.tabular,
                      ),
                    ),
                  const SizedBox(height: 12),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(999),
                    child: LinearProgressIndicator(
                      value: progress,
                      minHeight: 8,
                      color: UnnTheme.gold,
                      backgroundColor: Colors.white.withValues(alpha: 0.14),
                    ),
                  ),
                  const SizedBox(height: 8),
                  DefaultTextStyle(
                    style: const TextStyle(
                      color: UnnTheme.onForestMuted,
                      fontSize: 12.5,
                      fontFamily: UnnTheme.font,
                    ),
                    child: Wrap(
                      alignment: WrapAlignment.spaceBetween,
                      spacing: 12,
                      runSpacing: 2,
                      children: <Widget>[
                        Text(
                          paid.length == fees.items.length &&
                                  fees.items.isNotEmpty
                              ? 'Everything is paid. Well done.'
                              : '${paid.length} of ${fees.items.length} fees paid',
                        ),
                        if (paid.isNotEmpty && !_hideAmounts)
                          Text(
                              '${formatNaira(paidTotal.toStringAsFixed(2))} paid so far',),
                      ],
                    ),
                  ),
                  const SizedBox(height: 20),
                  Row(
                    children: <Widget>[
                      _action(
                        Icons.account_balance_wallet_outlined,
                        'Pay a fee',
                        _scrollToFees,
                        primary: true,
                      ),
                      _action(Icons.history_rounded, 'History',
                          () => _openTab(HomeTab.history),),
                      _action(
                        Icons.receipt_long_outlined,
                        'Receipts',
                        () => _openTab(HomeTab.receipts),
                      ),
                      _action(Icons.verified_user_outlined, 'Verify',
                          _verifyReceipt,),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _action(IconData icon, String label, VoidCallback onTap,
      {bool primary = false,}) {
    return Expanded(
      child: Semantics(
        button: true,
        label: label,
        child: InkWell(
          borderRadius: BorderRadius.circular(18),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Column(
              children: <Widget>[
                Container(
                  width: 54,
                  height: 54,
                  decoration: BoxDecoration(
                    color: primary
                        ? UnnTheme.gold
                        : Colors.white.withValues(alpha: 0.10),
                    borderRadius: BorderRadius.circular(18),
                  ),
                  child: Icon(icon,
                      color: primary ? UnnTheme.forest : Colors.white,
                      size: 23,),
                ),
                const SizedBox(height: 8),
                ExcludeSemantics(
                  child: Text(
                    label,
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _feeCard(FeeItem fee) {
    final bool payable =
        fee.status == FeeStatus.outstanding || fee.status == FeeStatus.pending;
    final bool busy = _starting == fee.feeItemId;
    final bool settled = fee.status == FeeStatus.paid;

    final (String subtitle, Color subtitleColor) = switch (fee.status) {
      FeeStatus.paid => (
          'Paid ${formatWat(fee.paidAt, withTime: false).replaceAll(RegExp(r' \d{4}$'), '')}'
              ' · ${fee.amountFormatted}',
          UnnTheme.muted,
        ),
      FeeStatus.pending => (
          'Awaiting transfer · ${fee.amountFormatted}',
          UnnTheme.amber
        ),
      FeeStatus.underReview => (
          'Being reviewed · ${fee.amountFormatted}',
          UnnTheme.orange
        ),
      FeeStatus.outstanding => (
          '${fee.category} · ${fee.amountFormatted}',
          UnnTheme.muted
        ),
    };

    final (Color tileBg, Color tileFg) = switch (fee.status) {
      FeeStatus.paid => (UnnTheme.divider, UnnTheme.muted),
      FeeStatus.pending => (UnnTheme.goldSoft, UnnTheme.amber),
      FeeStatus.underReview => (UnnTheme.orangeBg, UnnTheme.orange),
      FeeStatus.outstanding => (UnnTheme.mint, UnnTheme.green),
    };

    final Widget trailing;
    if (settled) {
      trailing = const ui.StatusChip(
        label: 'Paid',
        tone: ui.StatusTone.good,
        icon: Icons.check_rounded,
      );
    } else if (fee.status == FeeStatus.underReview) {
      trailing = const ui.StatusChip(
          label: 'Under review', tone: ui.StatusTone.attention,);
    } else if (payable) {
      final Widget label = busy
          ? ui.ButtonSpinner(
              color: fee.status == FeeStatus.pending
                  ? UnnTheme.green
                  : Colors.white,)
          : Text(fee.status == FeeStatus.pending ? 'Continue' : 'Pay now');
      trailing = fee.status == FeeStatus.pending
          ? OutlinedButton(
              onPressed: busy ? null : () => _pay(fee),
              style: OutlinedButton.styleFrom(
                minimumSize: const Size(96, 44),
                side: const BorderSide(color: UnnTheme.green, width: 1.5),
                foregroundColor: UnnTheme.green,
                padding: const EdgeInsets.symmetric(horizontal: 14),
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),),
              ),
              child: label,
            )
          : FilledButton(
              onPressed: busy ? null : () => _pay(fee),
              style: FilledButton.styleFrom(
                minimumSize: const Size(96, 44),
                padding: const EdgeInsets.symmetric(horizontal: 16),
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),),
                textStyle: const TextStyle(
                  fontFamily: UnnTheme.font,
                  fontSize: 14,
                  fontWeight: FontWeight.w700,
                ),
              ),
              child: label,
            );
    } else {
      trailing = const SizedBox.shrink();
    }

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: <Widget>[
              ui.IconTile(
                  icon: _iconFor(fee.category),
                  background: tileBg,
                  foreground: tileFg,),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      fee.name,
                      style: const TextStyle(
                          fontSize: 14.5, fontWeight: FontWeight.w700,),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      subtitle,
                      style: TextStyle(
                        fontSize: 12.5,
                        color: subtitleColor,
                        fontWeight: subtitleColor == UnnTheme.muted
                            ? FontWeight.w500
                            : FontWeight.w600,
                        fontFeatures: UnnTheme.tabular,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 10),
              trailing,
            ],
          ),
        ),
      ),
    );
  }
}

IconData _iconFor(String category) {
  final String c = category.toLowerCase();
  if (c.contains('tuition') || c.contains('school')) {
    return Icons.menu_book_rounded;
  }
  if (c.contains('hostel') || c.contains('accommodation')) {
    return Icons.bed_outlined;
  }
  if (c.contains('depart')) return Icons.groups_outlined;
  if (c.contains('accept')) return Icons.how_to_reg_outlined;
  if (c.contains('sport')) return Icons.emoji_events_outlined;
  return Icons.receipt_outlined;
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
