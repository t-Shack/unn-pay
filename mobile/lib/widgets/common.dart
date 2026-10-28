import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/theme.dart';

/// Shared building blocks for the UNN Pay look.

enum StatusTone { good, warning, attention, danger, neutral }

(Color, Color) _toneColors(StatusTone tone) => switch (tone) {
      StatusTone.good => (UnnTheme.greenLight, UnnTheme.greenDark),
      StatusTone.warning => (UnnTheme.goldSoft, UnnTheme.amber),
      StatusTone.attention => (UnnTheme.orangeBg, UnnTheme.orange),
      StatusTone.danger => (UnnTheme.redBg, UnnTheme.red),
      StatusTone.neutral => (UnnTheme.divider, UnnTheme.muted),
    };

class StatusChip extends StatelessWidget {
  const StatusChip(
      {super.key, required this.label, required this.tone, this.icon,});

  final String label;
  final StatusTone tone;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final (Color background, Color foreground) = _toneColors(tone);

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
          color: background, borderRadius: BorderRadius.circular(999),),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (icon != null) ...<Widget>[
            Icon(icon, size: 14, color: foreground),
            const SizedBox(width: 4),
          ],
          Text(
            label,
            style: TextStyle(
                color: foreground, fontSize: 12, fontWeight: FontWeight.w700,),
          ),
        ],
      ),
    );
  }
}

/// A rounded square holding an icon: fee categories, list rows, headers.
class IconTile extends StatelessWidget {
  const IconTile({
    super.key,
    required this.icon,
    this.background = UnnTheme.mint,
    this.foreground = UnnTheme.green,
    this.size = 44,
  });

  final IconData icon;
  final Color background;
  final Color foreground;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
          color: background, borderRadius: BorderRadius.circular(size * 0.32),),
      child: Icon(icon, color: foreground, size: size * 0.48),
    );
  }
}

/// The white rounded square buttons in screen headers (back, refresh, share).
class HeaderButton extends StatelessWidget {
  const HeaderButton(
      {super.key, required this.icon, required this.tooltip, this.onPressed,});

  final IconData icon;
  final String tooltip;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: Material(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: onPressed,
          child: SizedBox(
            width: 44,
            height: 44,
            child: Icon(icon,
                size: 21,
                color: onPressed == null ? UnnTheme.muted : UnnTheme.ink,),
          ),
        ),
      ),
    );
  }
}

/// A screen header in the new style: back button, title, optional actions.
class ScreenHeader extends StatelessWidget implements PreferredSizeWidget {
  const ScreenHeader(
      {super.key, required this.title, this.actions = const <Widget>[],});

  final String title;
  final List<Widget> actions;

  @override
  Size get preferredSize => const Size.fromHeight(68);

  @override
  Widget build(BuildContext context) {
    final bool canPop = Navigator.of(context).canPop();
    return SafeArea(
      bottom: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
        child: Row(
          children: <Widget>[
            if (canPop) ...<Widget>[
              HeaderButton(
                icon: Icons.chevron_left_rounded,
                tooltip: 'Back',
                onPressed: () => Navigator.of(context).maybePop(),
              ),
              const SizedBox(width: 12),
            ],
            Expanded(
              child: Text(
                title,
                style: TextStyle(
                  fontSize: canPop ? 16.5 : 24,
                  fontWeight: canPop ? FontWeight.w700 : FontWeight.w800,
                  letterSpacing: canPop ? 0 : -0.5,
                ),
              ),
            ),
            for (final Widget action in actions) ...<Widget>[
              const SizedBox(width: 8),
              action,
            ],
          ],
        ),
      ),
    );
  }
}

/// The deep forest card that holds money details, with the gold ring motif.
class ForestCard extends StatelessWidget {
  const ForestCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(20),
    this.radius = 24,
    this.ringSize = 190,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final double radius;
  final double ringSize;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: Container(
        color: UnnTheme.forest,
        child: Stack(
          children: <Widget>[
            Positioned(
              right: -ringSize * 0.28,
              bottom: -ringSize * 0.38,
              child: GoldRing(size: ringSize),
            ),
            Padding(
              padding: padding,
              child: DefaultTextStyle.merge(
                style: const TextStyle(color: Colors.white),
                child: child,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The single decorative motif: a faint gold ring.
class GoldRing extends StatelessWidget {
  const GoldRing({super.key, required this.size, this.opacity = 0.12});

  final double size;
  final double opacity;

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(
              color: UnnTheme.gold.withValues(alpha: opacity),
              width: size * 0.14,),
        ),
      ),
    );
  }
}

/// A value the student needs to copy accurately — an account number or a
/// payment reference. Tapping copies it, because typing a twelve digit
/// reference into a banking app by hand is where mistakes happen.
class CopyableValue extends StatelessWidget {
  const CopyableValue({
    super.key,
    required this.label,
    required this.value,
    this.emphasis = false,
    this.mono = false,
  });

  final String label;
  final String value;
  final bool emphasis;
  final bool mono;

  @override
  Widget build(BuildContext context) {
    final TextStyle valueStyle = mono
        ? UnnTheme.monoStyle(size: emphasis ? 18 : 15, color: UnnTheme.ink)
        : TextStyle(
            fontSize: emphasis ? 18 : 15.5,
            fontWeight: emphasis ? FontWeight.w800 : FontWeight.w700,
            fontFeatures: UnnTheme.tabular,
          );

    return InkWell(
      onTap: () => copyToClipboard(context, label, value),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 16),
        child: Row(
          children: <Widget>[
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    label,
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: UnnTheme.muted,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(value, style: valueStyle),
                ],
              ),
            ),
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: UnnTheme.divider,
                borderRadius: BorderRadius.circular(12),
              ),
              child: const Icon(Icons.copy_rounded,
                  size: 18, color: UnnTheme.green,),
            ),
          ],
        ),
      ),
    );
  }
}

void copyToClipboard(BuildContext context, String label, String value) {
  Clipboard.setData(ClipboardData(text: value));
  ScaffoldMessenger.of(context)
    ..clearSnackBars()
    ..showSnackBar(SnackBar(content: Text('$label copied')));
}

/// A label and value on one line, for receipts and summaries.
class DetailRow extends StatelessWidget {
  const DetailRow({
    super.key,
    required this.label,
    required this.value,
    this.mono = false,
    this.last = false,
  });

  final String label;
  final String value;
  final bool mono;
  final bool last;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 11),
      decoration: BoxDecoration(
        border: last
            ? null
            : const Border(bottom: BorderSide(color: UnnTheme.divider)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(label,
              style: const TextStyle(fontSize: 13, color: UnnTheme.muted),),
          const SizedBox(width: 16),
          Expanded(
            child: Text(
              value,
              textAlign: TextAlign.right,
              style: mono
                  ? UnnTheme.monoStyle(size: 13, color: UnnTheme.ink)
                  : const TextStyle(
                      fontSize: 13.5, fontWeight: FontWeight.w700,),
            ),
          ),
        ],
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
    final (Color background, Color foreground) = _toneColors(tone);
    final Color text = switch (tone) {
      StatusTone.warning => const Color(0xFF5C3200),
      StatusTone.neutral => UnnTheme.ink,
      _ => foreground,
    };
    final IconData icon = switch (tone) {
      StatusTone.good => Icons.check_circle_rounded,
      StatusTone.danger => Icons.error_rounded,
      StatusTone.neutral => Icons.info_rounded,
      _ => Icons.warning_rounded,
    };

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: tone == StatusTone.neutral ? Colors.white : background,
        borderRadius: BorderRadius.circular(18),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Icon(icon, size: 20, color: foreground),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                if (title != null) ...<Widget>[
                  Text(
                    title!,
                    style: TextStyle(
                        fontWeight: FontWeight.w800,
                        color: text,
                        fontSize: 14.5,),
                  ),
                  const SizedBox(height: 4),
                ],
                Text(message,
                    style:
                        TextStyle(color: text, fontSize: 13.5, height: 1.45),),
                if (action != null) ...<Widget>[
                  const SizedBox(height: 10),
                  action!,
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState(
      {super.key,
      required this.icon,
      required this.title,
      required this.message,});

  final IconData icon;
  final String title;
  final String message;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            IconTile(icon: icon, size: 60),
            const SizedBox(height: 16),
            Text(title,
                style:
                    const TextStyle(fontSize: 17, fontWeight: FontWeight.w800),),
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
    // Inside a ListView so pull to refresh still works on an error.
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(28),
      children: <Widget>[
        const SizedBox(height: 60),
        const Center(
          child: IconTile(
            icon: Icons.cloud_off_rounded,
            size: 60,
            background: UnnTheme.divider,
            foreground: UnnTheme.muted,
          ),
        ),
        const SizedBox(height: 16),
        Text(message,
            textAlign: TextAlign.center, style: const TextStyle(height: 1.5),),
        if (onRetry != null) ...<Widget>[
          const SizedBox(height: 20),
          Center(
            child: SizedBox(
              width: 180,
              child: OutlinedButton(
                  onPressed: onRetry, child: const Text('Try again'),),
            ),
          ),
        ],
      ],
    );
  }
}

/// A small spinner sized for the inside of a button.
class ButtonSpinner extends StatelessWidget {
  const ButtonSpinner({super.key, this.color = Colors.white});

  final Color color;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 20,
      height: 20,
      child: CircularProgressIndicator(strokeWidth: 2.2, color: color),
    );
  }
}
