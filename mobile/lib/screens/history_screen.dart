import 'package:flutter/material.dart';

import '../models/models.dart';
import '../services/api_client.dart';
import '../services/app_state.dart';
import '../theme/theme.dart';
import '../widgets/common.dart' as ui;
import 'payment_screen.dart';
import 'receipt_screen.dart';

/// Payment history (§11.3), paginated.
class HistoryScreen extends StatefulWidget {
  const HistoryScreen({super.key, required this.state});

  final AppState state;

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

  @override
  void initState() {
    super.initState();
    _load();
    _scroll.addListener(() {
      if (_scroll.position.pixels > _scroll.position.maxScrollExtent - 300) _loadMore();
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
            (response['items'] as List<dynamic>)
                .map((dynamic item) => Payment.fromJson(item as Map<String, dynamic>)),
          );
        _page = 1;
        _totalPages = (response['pagination'] as Map<String, dynamic>)['total_pages'] as int;
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
      final Map<String, dynamic> response = await widget.state.api.history(page: _page + 1);
      if (!mounted) return;
      setState(() {
        _page += 1;
        _items.addAll(
          (response['items'] as List<dynamic>)
              .map((dynamic item) => Payment.fromJson(item as Map<String, dynamic>)),
        );
      });
    } on ApiException {
      // A failed "load more" leaves what is already on screen intact.
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Payment history')),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? ui.ErrorView(message: _error!, onRetry: _load)
                : _items.isEmpty
                    ? const ui.EmptyState(
                        icon: Icons.receipt_long_rounded,
                        title: 'No payments yet',
                        message: 'Payments you make will appear here with their receipts.',
                      )
                    : ListView.builder(
                        controller: _scroll,
                        padding: const EdgeInsets.all(16),
                        itemCount: _items.length + (_page < _totalPages ? 1 : 0),
                        itemBuilder: (BuildContext context, int index) {
                          if (index >= _items.length) {
                            return const Padding(
                              padding: EdgeInsets.all(20),
                              child: Center(child: CircularProgressIndicator()),
                            );
                          }
                          return _tile(_items[index]);
                        },
                      ),
      ),
    );
  }

  Widget _tile(Payment payment) {
    final (String label, ui.StatusTone tone) = switch (payment.status) {
      'Successful' => ('Paid', ui.StatusTone.good),
      'UnderReview' => ('Under review', ui.StatusTone.warning),
      'Failed' => ('Failed', ui.StatusTone.danger),
      'Expired' => ('Expired', ui.StatusTone.neutral),
      _ => ('Pending', ui.StatusTone.neutral),
    };

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Card(
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () {
            final Widget destination = payment.isSettled && payment.receipt != null
                ? ReceiptScreen(state: widget.state, payment: payment)
                : PaymentScreen(state: widget.state, payment: payment);
            Navigator.of(context)
                .push(MaterialPageRoute<void>(builder: (_) => destination))
                .then((_) => _load());
          },
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Expanded(
                      child: Text(
                        payment.feeItemName ?? 'Fee payment',
                        style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
                      ),
                    ),
                    ui.StatusChip(label: label, tone: tone),
                  ],
                ),
                const SizedBox(height: 8),
                Text(
                  payment.reference,
                  style: const TextStyle(
                    fontSize: 12.5,
                    color: UnnTheme.muted,
                    letterSpacing: 0.4,
                  ),
                ),
                const SizedBox(height: 10),
                Row(
                  children: <Widget>[
                    Text(
                      payment.amountPaidFormatted ?? payment.expectedAmountFormatted,
                      style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
                    ),
                    const Spacer(),
                    Text(
                      formatWat(payment.paidAt ?? payment.expiresAt, withTime: false),
                      style: const TextStyle(fontSize: 12, color: UnnTheme.muted),
                    ),
                    const SizedBox(width: 6),
                    const Icon(Icons.chevron_right_rounded, size: 18, color: UnnTheme.muted),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
