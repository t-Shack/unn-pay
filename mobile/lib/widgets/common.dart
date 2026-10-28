import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/theme.dart';

/// Small shared pieces, kept deliberately plain.

class StatusChip extends StatelessWidget {
  const StatusChip({super.key, required this.label, required this.tone});

  final String label;
  final StatusTone tone;

  @override
  Widget build(BuildContext context) {
    final (Color background, Color foreground) = switch (tone) {
      StatusTone.good => (UnnTheme.greenLight, UnnTheme.greenDark),
      StatusTone.warning => (UnnTheme.amberBg, UnnTheme.amber),
      StatusTone.danger => (UnnTheme.redBg, UnnTheme.red),
      StatusTone.neutral => (const Color(0xFFF3F4F6), UnnTheme.muted),
    };

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: TextStyle(color: foreground, fontSize: 12, fontWeight: FontWeight.w600),
      ),
    );
  }
}

enum StatusTone { good, warning, danger, neutral }

/// A value the student needs to copy accurately — an account number or a
/// payment reference. Tapping copies it, because typing a twelve digit
/// reference into a banking app by hand is where mistakes happen.
class CopyableValue extends StatelessWidget {
  const CopyableValue({
    super.key,
    required this.label,
    required this.value,
    this.emphasis = false,
  });

  final String label;
  final String value;
  final bool emphasis;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(10),
      onTap: () {
        Clipboard.setData(ClipboardData(text: value));
        ScaffoldMessenger.of(context)
          ..clearSnackBars()
          ..showSnackBar(SnackBar(content: Text('$label copied')));
      },
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 12),
        child: Row(
          children: <Widget>[
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(label, style: const TextStyle(fontSize: 12, color: UnnTheme.muted)),
                  const SizedBox(height: 3),
                  Text(
                    value,
                    style: TextStyle(
                      fontSize: emphasis ? 20 : 16,
                      fontWeight: FontWeight.w700,
                      letterSpacing: emphasis ? 1.1 : 0.4,
                      fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
                    ),
                  ),
                ],
              ),
            ),
            const Icon(Icons.copy_rounded, size: 18, color: UnnTheme.muted),
          ],
        ),
      ),
    );
  }
}

class NoticeBanner extends StatelessWidget {
  const NoticeBanner({
    super.key,
    required this.message,
    this.tone = StatusTone.warning,
    this.title,
    this.action,
  });

  final String message;
  final String? title;
  final StatusTone tone;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final (Color background, Color border, Color foreground) = switch (tone) {
      StatusTone.good => (UnnTheme.greenLight, const Color(0xFFBBF7D0), UnnTheme.greenDark),
      StatusTone.warning => (UnnTheme.amberBg, const Color(0xFFFDE68A), UnnTheme.amber),
      StatusTone.danger => (UnnTheme.redBg, const Color(0xFFFECDCA), UnnTheme.red),
      StatusTone.neutral => (Colors.white, UnnTheme.line, UnnTheme.ink),
    };

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: background,
        border: Border.all(color: border),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (title != null) ...<Widget>[
            Text(
              title!,
              style: TextStyle(fontWeight: FontWeight.w700, color: foreground, fontSize: 14.5),
            ),
            const SizedBox(height: 4),
          ],
          Text(message, style: TextStyle(color: foreground, fontSize: 13.5, height: 1.45)),
          if (action != null) ...<Widget>[const SizedBox(height: 10), action!],
        ],
      ),
    );
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.title, required this.message});

  final IconData icon;
  final String title;
  final String message;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            Icon(icon, size: 42, color: UnnTheme.muted),
            const SizedBox(height: 14),
            Text(title, style: const TextStyle(fontSize: 16.5, fontWeight: FontWeight.w600)),
            const SizedBox(height: 6),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(color: UnnTheme.muted, height: 1.5),
            ),
          ],
        ),
      ),
    );
  }
}

/// The one place an API error becomes something a student reads. Never shows a
/// stack trace or a correlation id unless there is nothing more useful to say.
class ErrorView extends StatelessWidget {
  const ErrorView({super.key, required this.message, this.onRetry});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            const Icon(Icons.cloud_off_rounded, size: 40, color: UnnTheme.muted),
            const SizedBox(height: 14),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(height: 1.5),
            ),
            if (onRetry != null) ...<Widget>[
              const SizedBox(height: 18),
              OutlinedButton(onPressed: onRetry, child: const Text('Try again')),
            ],
          ],
        ),
      ),
    );
  }
}
