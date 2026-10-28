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
import 'payment_screen.dart' show channelInfo;

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
      final List<int> bytes =
          await widget.state.api.receiptPdf(widget.payment.reference);
      final Directory directory = await getTemporaryDirectory();
      final String name =
          'UNN-Pay-Receipt-${widget.payment.receipt!.receiptNumber.replaceAll('/', '-')}.pdf';
      final File file = File('${directory.path}/$name');
      await file.writeAsBytes(bytes);
      await OpenFilex.open(file.path);
    } on ApiException catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.message)));
      }
    } finally {
      if (mounted) setState(() => _downloading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final Receipt receipt = widget.payment.receipt!;
    final String verifyUrl =
        '${widget.state.api.baseUrl}/verify/${receipt.verificationCode}';
    final Student student = widget.state.student!;

    return Scaffold(
      appBar: ui.ScreenHeader(
        title: 'Receipt',
        actions: <Widget>[
          ui.HeaderButton(
            icon: Icons.link_rounded,
            tooltip: 'Copy verification link',
            onPressed: () =>
                ui.copyToClipboard(context, 'Verification link', verifyUrl),
          ),
        ],
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
          child: FilledButton.icon(
            onPressed: _downloading ? null : _openPdf,
            icon: _downloading
                ? const ui.ButtonSpinner()
                : const Icon(Icons.download_rounded),
            label: Text(_downloading ? 'Preparing…' : 'Download PDF receipt'),
          ),
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
        children: <Widget>[
          Container(
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(24),
              boxShadow: const <BoxShadow>[
                BoxShadow(
                    color: Color(0x0F0F1D17),
                    blurRadius: 10,
                    offset: Offset(0, 2),),
              ],
            ),
            clipBehavior: Clip.antiAlias,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                _band(),
                Padding(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 20, vertical: 4),
                  child: Column(
                    children: <Widget>[
                      ui.DetailRow(label: 'Student', value: student.fullName),
                      ui.DetailRow(
                          label: 'Matric number', value: student.matricNumber,),
                      ui.DetailRow(
                        label: 'Receipt number',
                        value: receipt.receiptNumber,
                        mono: true,
                      ),
                      ui.DetailRow(
                        label: 'Payment reference',
                        value: widget.payment.reference,
                        mono: true,
                      ),
                      ui.DetailRow(
                          label: 'Paid on',
                          value: formatWat(widget.payment.paidAt),),
                      ui.DetailRow(
                        label: 'Channel',
                        value: channelInfo(widget.payment.channel ?? 'transfer')
                            .$1,
                        last: true,
                      ),
                    ],
                  ),
                ),
                const _Perforation(),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
                  child: Row(
                    children: <Widget>[
                      Container(
                        padding: const EdgeInsets.all(6),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          border: Border.all(color: UnnTheme.line),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: QrImageView(
                          data: verifyUrl,
                          version: QrVersions.auto,
                          size: 118,
                          padding: EdgeInsets.zero,
                          backgroundColor: Colors.white,
                          eyeStyle: const QrEyeStyle(
                            eyeShape: QrEyeShape.square,
                            color: UnnTheme.forest,
                          ),
                          dataModuleStyle: const QrDataModuleStyle(
                            dataModuleShape: QrDataModuleShape.square,
                            color: UnnTheme.forest,
                          ),
                          errorCorrectionLevel: QrErrorCorrectLevel.M,
                          semanticsLabel: 'Verification QR code',
                        ),
                      ),
                      const SizedBox(width: 16),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            const Row(
                              children: <Widget>[
                                Icon(Icons.verified_user_rounded,
                                    size: 17, color: UnnTheme.green,),
                                SizedBox(width: 6),
                                Flexible(
                                  child: Text(
                                    'Signed by UNN',
                                    style: TextStyle(
                                      fontSize: 13.5,
                                      fontWeight: FontWeight.w800,
                                      color: UnnTheme.green,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 6),
                            const Text(
                              'Anyone can verify this receipt: scan the code, or enter the code '
                              'below on the University\'s verification page.',
                              style: TextStyle(
                                  fontSize: 12,
                                  height: 1.45,
                                  color: UnnTheme.muted,),
                            ),
                            const SizedBox(height: 8),
                            InkWell(
                              onTap: () => ui.copyToClipboard(
                                context,
                                'Verification code',
                                receipt.verificationCode,
                              ),
                              child: Padding(
                                padding:
                                    const EdgeInsets.symmetric(vertical: 4),
                                child: Row(
                                  children: <Widget>[
                                    Flexible(
                                      child: Text(
                                        receipt.verificationCode,
                                        style: UnnTheme.monoStyle(
                                            size: 14.5, color: UnnTheme.ink,),
                                      ),
                                    ),
                                    const SizedBox(width: 6),
                                    const Icon(
                                      Icons.copy_rounded,
                                      size: 15,
                                      color: UnnTheme.green,
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          const Text(
            'The PDF is issued and signed by the University. An edited copy fails verification.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, color: UnnTheme.muted, height: 1.4),
          ),
        ],
      ),
    );
  }

  Widget _band() {
    return Container(
      color: UnnTheme.forest,
      child: Stack(
        children: <Widget>[
          const Positioned(right: -40, top: -60, child: ui.GoldRing(size: 150)),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    const Expanded(
                      child: Text(
                        'UNIVERSITY OF NIGERIA, NSUKKA',
                        style: TextStyle(
                          fontSize: 10.5,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 0.8,
                          color: UnnTheme.gold,
                        ),
                      ),
                    ),
                    Transform.rotate(
                      angle: -0.07,
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 8, vertical: 4,),
                        decoration: BoxDecoration(
                          border: Border.all(color: UnnTheme.gold, width: 1.5),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: const Text(
                          'PAID IN FULL',
                          style: TextStyle(
                            fontSize: 10.5,
                            fontWeight: FontWeight.w800,
                            letterSpacing: 0.6,
                            color: UnnTheme.gold,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Text(
                  widget.payment.feeItemName ?? 'Fee payment',
                  style: const TextStyle(
                      color: UnnTheme.onForestMuted, fontSize: 13,),
                ),
                const SizedBox(height: 2),
                Text(
                  widget.payment.amountPaidFormatted ??
                      widget.payment.expectedAmountFormatted,
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 32,
                    fontWeight: FontWeight.w800,
                    letterSpacing: -1,
                    fontFeatures: UnnTheme.tabular,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The torn-ticket edge between the details and the verification block.
class _Perforation extends StatelessWidget {
  const _Perforation();

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 22,
      child: Stack(
        clipBehavior: Clip.none,
        alignment: Alignment.center,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: LayoutBuilder(
              builder: (BuildContext context, BoxConstraints constraints) {
                final int dashes = (constraints.maxWidth / 10).floor();
                return Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: List<Widget>.generate(
                    dashes,
                    (_) => Container(width: 5, height: 2, color: UnnTheme.line),
                  ),
                );
              },
            ),
          ),
          Positioned(left: -11, child: _notch()),
          Positioned(right: -11, child: _notch()),
        ],
      ),
    );
  }

  Widget _notch() => Container(
        width: 22,
        height: 22,
        decoration:
            const BoxDecoration(color: UnnTheme.canvas, shape: BoxShape.circle),
      );
}
