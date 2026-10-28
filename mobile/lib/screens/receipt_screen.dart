import 'dart:io';

import 'package:flutter/material.dart';
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../models/models.dart';
import '../services/api_client.dart';
import '../services/app_state.dart';
import '../theme/theme.dart';
import '../widgets/common.dart' as ui;

/// The receipt (§8).
///
/// The QR code and the short verification code both point at the University's
/// own verification page, so anyone — a Bursary clerk, a landlord, a parent —
/// can confirm this receipt is genuine without trusting the phone showing it.
///
/// The PDF is fetched from the server, never assembled here: an artefact built
/// on the client is something the client asserts, not something UNN attests.
class ReceiptScreen extends StatefulWidget {
  const ReceiptScreen({super.key, required this.state, required this.payment});

  final AppState state;
  final Payment payment;

  @override
  State<ReceiptScreen> createState() => _ReceiptScreenState();
}

class _ReceiptScreenState extends State<ReceiptScreen> {
  bool _downloading = false;

  Future<void> _openPdf() async {
    setState(() => _downloading = true);
    try {
      final List<int> bytes = await widget.state.api.receiptPdf(widget.payment.reference);
      final Directory directory = await getTemporaryDirectory();
      final String name =
          'UNN-Pay-Receipt-${widget.payment.receipt!.receiptNumber.replaceAll('/', '-')}.pdf';
      final File file = File('${directory.path}/$name');
      await file.writeAsBytes(bytes);
      await OpenFilex.open(file.path);
    } on ApiException catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error.message)));
      }
    } finally {
      if (mounted) setState(() => _downloading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final Receipt receipt = widget.payment.receipt!;
    final String verifyUrl = '${widget.state.api.baseUrl}/verify/${receipt.verificationCode}';
    final Student student = widget.state.student!;

    return Scaffold(
      appBar: AppBar(title: const Text('Receipt')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: <Widget>[
          Card(
            child: Column(
              children: <Widget>[
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(vertical: 22),
                  decoration: const BoxDecoration(
                    color: UnnTheme.greenLight,
                    borderRadius: BorderRadius.vertical(top: Radius.circular(11)),
                  ),
                  child: Column(
                    children: <Widget>[
                      const Icon(Icons.verified_rounded, color: UnnTheme.green, size: 38),
                      const SizedBox(height: 8),
                      const Text(
                        'PAID IN FULL',
                        style: TextStyle(
                          color: UnnTheme.greenDark,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 1,
                          fontSize: 13,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        widget.payment.amountPaidFormatted ??
                            widget.payment.expectedAmountFormatted,
                        style: const TextStyle(
                          fontSize: 30,
                          fontWeight: FontWeight.w700,
                          color: UnnTheme.greenDark,
                          letterSpacing: -0.8,
                        ),
                      ),
                    ],
                  ),
                ),
                _row('Student', student.fullName),
                _row('Matric number', student.matricNumber),
                _row('Fee', widget.payment.feeItemName ?? '—'),
                _row('Receipt number', receipt.receiptNumber),
                _row('Payment reference', widget.payment.reference),
                _row('Paid on', formatWat(widget.payment.paidAt)),
                _row('Channel', _channelLabel(widget.payment.channel), last: true),
              ],
            ),
          ),
          const SizedBox(height: 16),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                children: <Widget>[
                  const Text(
                    'Anyone can verify this receipt',
                    style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 6),
                  const Text(
                    'Scan this code, or type the code below at the address shown. It checks '
                    'against the University’s own records.',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 13, color: UnnTheme.muted, height: 1.45),
                  ),
                  const SizedBox(height: 18),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      border: Border.all(color: UnnTheme.line),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: QrImageView(
                      data: verifyUrl,
                      version: QrVersions.auto,
                      size: 176,
                      backgroundColor: Colors.white,
                      errorCorrectionLevel: QrErrorCorrectLevel.M,
                    ),
                  ),
                  const SizedBox(height: 18),
                  ui.CopyableValue(
                    label: 'Verification code',
                    value: receipt.verificationCode,
                    emphasis: true,
                  ),
                  const SizedBox(height: 6),
                  Text(
                    verifyUrl,
                    textAlign: TextAlign.center,
                    style: const TextStyle(fontSize: 11.5, color: UnnTheme.muted),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: _downloading ? null : _openPdf,
            icon: _downloading
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                  )
                : const Icon(Icons.picture_as_pdf_rounded),
            label: Text(_downloading ? 'Preparing…' : 'Download PDF receipt'),
          ),
          const SizedBox(height: 10),
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 8),
            child: Text(
              'The PDF is issued and signed by the University. An edited copy fails verification.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12, color: UnnTheme.muted, height: 1.4),
            ),
          ),
          const SizedBox(height: 24),
        ],
      ),
    );
  }

  Widget _row(String label, String value, {bool last = false}) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
      decoration: BoxDecoration(
        border: last ? null : const Border(bottom: BorderSide(color: UnnTheme.line)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          SizedBox(
            width: 130,
            child: Text(label, style: const TextStyle(fontSize: 12.5, color: UnnTheme.muted)),
          ),
          Expanded(
            child: Text(
              value,
              textAlign: TextAlign.right,
              style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5),
            ),
          ),
        ],
      ),
    );
  }
}

String _channelLabel(String? channel) => switch (channel) {
      'transfer' => 'Bank transfer',
      'ussd' => 'USSD',
      'card' => 'Card',
      'pos' => 'POS terminal',
      'bank_branch' => 'Bank branch',
      _ => 'Bank transfer',
    };
