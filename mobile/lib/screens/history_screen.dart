import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../models/models.dart';
import '../services/api_client.dart';
import '../services/app_state.dart';
import '../theme/theme.dart';
import '../widgets/common.dart' as ui;
import 'payment_screen.dart';
import 'receipt_screen.dart';

enum _Filter { all, paid, pending, review }

/// Payment history (§11.3), paginated. With [receiptsOnly] it is the Receipts
/// tab: the same list, narrowed to payments that have a receipt.
class HistoryScreen extends StatefulWidget {
  const HistoryScreen(
      {super.key, required this.state, this.receiptsOnly = false,});

  final AppState state;
  final bool receiptsOnly;

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  final List<Payment> _items = <Payment>[];
  final ScrollController _scroll = ScrollController();

  int _page = 1;
  int _totalPages = 1;
  bool _loading = true;
  bool _loadingMore = false;
  String? _error;
  _Filter _filter = _Filter.all;

  @override
  void initState() {
    super.initState();
    _load();
    _scroll.addListener(() {
      if (_scroll.position.pixels > _scroll.position.maxScrollExtent - 300) {
        _loadMore();
      }
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final Map<String, dynamic> response = await widget.state.api.history();
      if (!mounted) return;
      setState(() {
        _items
          ..clear()
          ..addAll(
            (response['items'] as List<dynamic>).map((dynamic item) =>
                Payment.fromJson(item as Map<String, dynamic>),),
          );
        _page = 1;
        _totalPages = (response['pagination']
            as Map<String, dynamic>)['total_pages'] as int;
      });
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _loadMore() async {
    if (_loadingMore || _page >= _totalPages) return;
    setState(() => _loadingMore = true);
    try {
      final Map<String, dynamic> response =
          await widget.state.api.history(page: _page + 1);
      if (!mounted) return;
      setState(() {
        _page += 1;
        _items.addAll(
          (response['items'] as List<dynamic>).map(
              (dynamic item) => Payment.fromJson(item as Map<String, dynamic>),),
        );
      });
    } on ApiException {
      // A failed "load more" leaves what is already on screen intact.
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  List<Payment> get _visible {
    if (widget.receiptsOnly) {
      return _items
          .where((Payment p) => p.isSettled && p.receipt != null)
          .toList();
    }
    return switch (_filter) {
      _Filter.all => _items,
      _Filter.paid => _items.where((Payment p) => p.isSettled).toList(),
      _Filter.pending =>
        _items.where((Payment p) => p.isPending && !p.isExpired).toList(),
      _Filter.review => _items.where((Payment p) => p.needsAttention).toList(),
    };
  }

  void _open(Payment payment) {
    final Widget destination = payment.isSettled && payment.receipt != null
        ? ReceiptScreen(state: widget.state, payment: payment)
        : PaymentScreen(state: widget.state, payment: payment);
    Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => destination))
        .then((_) => _load());
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar:
          ui.ScreenHeader(title: widget.receiptsOnly ? 'Receipts' : 'History'),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? ui.ErrorView(message: _error!, onRetry: _load)
                : _items.isEmpty
                    ? _empty()
                    : ListView(
                        controller: _scroll,
                        physics: const AlwaysScrollableScrollPhysics(),
                        padding: const EdgeInsets.fromLTRB(20, 4, 20, 28),
                        children: <Widget>[
                          _summary(),
                          if (!widget.receiptsOnly) ...<Widget>[
                            const SizedBox(height: 14),
                            _filters(),
                          ],
                          ..._groups(),
                          if (_page < _totalPages)
                            const Padding(
                              padding: EdgeInsets.all(20),
                              child: Center(child: CircularProgressIndicator()),
                            ),
                        ],
                      ),
      ),
    );
  }

  Widget _empty() {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: <Widget>[
        const SizedBox(height: 80),
        ui.EmptyState(
          icon: Icons.receipt_long_rounded,
          title: widget.receiptsOnly ? 'No receipts yet' : 'No payments yet',
          message: widget.receiptsOnly
              ? 'Receipts for the fees you pay will appear here.'
              : 'Payments you make will appear here with their receipts.',
        ),
      ],
    );
  }

  Widget _summary() {
    final List<Payment> settled =
        _items.where((Payment p) => p.isSettled).toList();
    final double total = settled.fold<double>(
      0,
      (double sum, Payment p) =>
          sum + (double.tryParse(p.amountPaid ?? p.expectedAmount) ?? 0),
    );
    final int receipts = settled.where((Payment p) => p.receipt != null).length;

    return ui.ForestCard(
      radius: 22,
      ringSize: 130,
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
      child: Row(
        children: <Widget>[
          Expanded(
              child:
                  _stat('Paid so far', formatNaira(total.toStringAsFixed(2))),),
          Expanded(child: _stat('Receipts', '$receipts', accent: true)),
        ],
      ),
    );
  }

  Widget _stat(String label, String value, {bool accent = false}) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          label,
          style: const TextStyle(
            color: UnnTheme.onForestMuted,
            fontSize: 12,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 3),
        Text(
          value,
          style: TextStyle(
            color: accent ? UnnTheme.gold : Colors.white,
            fontSize: 22,
            fontWeight: FontWeight.w800,
            letterSpacing: -0.5,
            fontFeatures: UnnTheme.tabular,
          ),
        ),
      ],
    );
  }

  Widget _filters() {
    const Map<_Filter, String> labels = <_Filter, String>{
      _Filter.all: 'All',
      _Filter.paid: 'Paid',
      _Filter.pending: 'Pending',
      _Filter.review: 'Review',
    };
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: labels.entries.map((MapEntry<_Filter, String> entry) {
          final bool selected = entry.key == _filter;
          return Padding(
            padding: const EdgeInsets.only(right: 8),
            child: Material(
              color: selected ? UnnTheme.ink : Colors.white,
              shape: StadiumBorder(
                side:
                    BorderSide(color: selected ? UnnTheme.ink : UnnTheme.line),
              ),
              child: InkWell(
                customBorder: const StadiumBorder(),
                onTap: () => setState(() => _filter = entry.key),
                child: Padding(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                  child: Text(
                    entry.value,
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: selected ? FontWeight.w700 : FontWeight.w600,
                      color: selected ? Colors.white : UnnTheme.ink,
                    ),
                  ),
                ),
              ),
            ),
          );
        }).toList(),
      ),
    );
  }

  /// Payments grouped by month, newest first, in West Africa Time.
  List<Widget> _groups() {
    final List<Payment> visible = _visible;
    if (visible.isEmpty) {
      return <Widget>[
        const SizedBox(height: 40),
        const Center(
          child: Text('Nothing here yet.',
              style: TextStyle(color: UnnTheme.muted),),
        ),
      ];
    }

    final DateFormat month = DateFormat('MMMM yyyy');
    final Map<String, List<Payment>> groups = <String, List<Payment>>{};
    for (final Payment payment in visible) {
      final DateTime when = (payment.paidAt ?? payment.expiresAt)
          .toUtc()
          .add(const Duration(hours: 1));
      groups
          .putIfAbsent(month.format(when).toUpperCase(), () => <Payment>[])
          .add(payment);
    }

    final List<Widget> out = <Widget>[];
    groups.forEach((String label, List<Payment> payments) {
      out
        ..add(const SizedBox(height: 18))
        ..add(
          Padding(
            padding: const EdgeInsets.only(left: 2, bottom: 10),
            child: Text(
              label,
              style: const TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.6,
                color: UnnTheme.muted,
              ),
            ),
          ),
        )
        ..add(
          Card(
            clipBehavior: Clip.antiAlias,
            child: Column(
              children: <Widget>[
                for (int i = 0; i < payments.length; i += 1)
                  _row(payments[i], last: i == payments.length - 1),
              ],
            ),
          ),
        );
    });
    return out;
  }

  Widget _row(Payment payment, {required bool last}) {
    final String status = payment.isExpired ? 'Expired' : payment.status;
    final (
      String label,
      Color color,
      Color tile,
      IconData icon,
      String detail
    ) = switch (status) {
      'Successful' => (
          'Paid',
          UnnTheme.greenDark,
          UnnTheme.greenLight,
          Icons.check_rounded,
          payment.receipt != null
              ? 'Receipt ${payment.receipt!.receiptNumber.split('/').last}'
              : 'Paid',
        ),
      'UnderReview' => (
          'Under review',
          UnnTheme.orange,
          UnnTheme.orangeBg,
          Icons.warning_amber_rounded,
          'Needs attention',
        ),
      'Failed' => (
          'Failed',
          UnnTheme.red,
          UnnTheme.redBg,
          Icons.close_rounded,
          'Did not go through'
        ),
      'Expired' => (
          'Expired',
          UnnTheme.muted,
          UnnTheme.divider,
          Icons.timer_off_outlined,
          'Reference expired',
        ),
      _ => (
          'Pending',
          UnnTheme.amber,
          UnnTheme.goldSoft,
          Icons.schedule_rounded,
          'Awaiting transfer'
        ),
    };

    final String date =
        formatWat(payment.paidAt ?? payment.expiresAt, withTime: false)
            .replaceAll(RegExp(r' \d{4}$'), '');

    return InkWell(
      onTap: () => _open(payment),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          border: last
              ? null
              : const Border(bottom: BorderSide(color: UnnTheme.divider)),
        ),
        child: Row(
          children: <Widget>[
            ui.IconTile(
                icon: icon, size: 42, background: tile, foreground: color,),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    payment.feeItemName ?? 'Fee payment',
                    style: const TextStyle(
                        fontSize: 14, fontWeight: FontWeight.w700,),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '$date · $detail',
                    style: const TextStyle(fontSize: 12, color: UnnTheme.muted),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 10),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: <Widget>[
                Text(
                  payment.amountPaidFormatted ??
                      payment.expectedAmountFormatted,
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w800,
                    color: status == 'Expired' ? UnnTheme.muted : UnnTheme.ink,
                    fontFeatures: UnnTheme.tabular,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  label,
                  style: TextStyle(
                      fontSize: 11.5,
                      fontWeight: FontWeight.w700,
                      color: color,),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
