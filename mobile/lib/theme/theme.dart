import 'package:flutter/material.dart';

/// UNN Pay visual language: forest green and University gold.
///
/// Money details sit on deep forest cards, the one primary action on each
/// screen is green, and gold is reserved for emphasis (the balance progress,
/// the copy button, the success mark). Everything is chosen for legibility on a
/// mid range Android phone in daylight: high contrast, large numbers, generous
/// tap targets.
class UnnTheme {
  const UnnTheme._();

  static const String font = 'PlusJakartaSans';
  static const String mono = 'JetBrainsMono';

  // Brand
  static const Color forest = Color(0xFF0A3B2C);
  static const Color green = Color(0xFF0E6B4A);
  static const Color greenDark = Color(0xFF0B5E40);
  static const Color mint = Color(0xFFD9F2E6);
  static const Color greenLight = Color(0xFFDDF3E8);
  static const Color gold = Color(0xFFF2B630);
  static const Color goldSoft = Color(0xFFFFF3D1);

  // Neutrals
  static const Color ink = Color(0xFF0F1D17);
  static const Color muted = Color(0xFF56665E);
  static const Color line = Color(0xFFE3E8E4);
  static const Color divider = Color(0xFFEEF1EE);
  static const Color canvas = Color(0xFFF3F5F1);
  static const Color field = Color(0xFFF7F9F7);

  // Status
  static const Color amber = Color(0xFF8A4B00);
  static const Color amberBg = goldSoft;
  static const Color orange = Color(0xFF9A3412);
  static const Color orangeBg = Color(0xFFFDE8D7);
  static const Color red = Color(0xFFB42318);
  static const Color redBg = Color(0xFFFDECEA);

  /// White text on a forest card, at the strength used for secondary labels.
  static const Color onForestMuted = Color(0xBDFFFFFF);

  static const List<FontFeature> tabular = <FontFeature>[
    FontFeature.tabularFigures(),
  ];

  /// References, account numbers and codes: monospaced, so a student reading
  /// them aloud or copying them by eye cannot confuse one digit for another.
  static TextStyle monoStyle(
          {double size = 15,
          Color? color,
          FontWeight weight = FontWeight.w600,}) =>
      TextStyle(
        fontFamily: mono,
        fontSize: size,
        fontWeight: weight,
        color: color,
        letterSpacing: 0.4,
      );

  static ThemeData get light {
    final ColorScheme scheme = ColorScheme.fromSeed(
      seedColor: green,
      primary: green,
      secondary: gold,
      surface: Colors.white,
    );

    final OutlineInputBorder fieldBorder = OutlineInputBorder(
      borderRadius: BorderRadius.circular(16),
      borderSide: const BorderSide(color: line, width: 1.5),
    );

    return ThemeData(
      useMaterial3: true,
      fontFamily: font,
      colorScheme: scheme,
      scaffoldBackgroundColor: canvas,
      appBarTheme: const AppBarTheme(
        backgroundColor: canvas,
        foregroundColor: ink,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: TextStyle(
          fontFamily: font,
          color: ink,
          fontSize: 17,
          fontWeight: FontWeight.w700,
        ),
      ),
      cardTheme: CardThemeData(
        color: Colors.white,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: green,
          foregroundColor: Colors.white,
          disabledBackgroundColor: green.withValues(alpha: 0.55),
          disabledForegroundColor: Colors.white,
          minimumSize: const Size.fromHeight(56),
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          textStyle: const TextStyle(
              fontFamily: font, fontSize: 16, fontWeight: FontWeight.w700,),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: forest,
          minimumSize: const Size.fromHeight(54),
          side: const BorderSide(color: forest, width: 1.5),
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          textStyle: const TextStyle(
              fontFamily: font, fontSize: 15, fontWeight: FontWeight.w700,),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: green,
          textStyle: const TextStyle(
              fontFamily: font, fontSize: 14, fontWeight: FontWeight.w700,),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: Colors.white,
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 16, vertical: 17),
        border: fieldBorder,
        enabledBorder: fieldBorder,
        focusedBorder: fieldBorder.copyWith(
            borderSide: const BorderSide(color: green, width: 2),),
        errorBorder: fieldBorder.copyWith(
            borderSide: const BorderSide(color: red, width: 1.5),),
        focusedErrorBorder: fieldBorder.copyWith(
            borderSide: const BorderSide(color: red, width: 2),),
        labelStyle: const TextStyle(color: muted, fontWeight: FontWeight.w500),
        floatingLabelStyle:
            const TextStyle(color: green, fontWeight: FontWeight.w700),
        hintStyle: const TextStyle(color: Color(0xFF8A968F)),
        prefixIconColor: muted,
        suffixIconColor: muted,
      ),
      dividerTheme:
          const DividerThemeData(color: divider, space: 1, thickness: 1),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: ink,
        contentTextStyle:
            const TextStyle(fontFamily: font, fontWeight: FontWeight.w600),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
        titleTextStyle: const TextStyle(
          fontFamily: font,
          color: ink,
          fontSize: 19,
          fontWeight: FontWeight.w800,
        ),
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.white,
        indicatorColor: mint,
        elevation: 0,
        height: 72,
        labelTextStyle:
            WidgetStateProperty.resolveWith((Set<WidgetState> states) {
          final bool selected = states.contains(WidgetState.selected);
          return TextStyle(
            fontFamily: font,
            fontSize: 11.5,
            fontWeight: selected ? FontWeight.w700 : FontWeight.w600,
            color: selected ? green : muted,
          );
        }),
        iconTheme: WidgetStateProperty.resolveWith((Set<WidgetState> states) {
          return IconThemeData(
              color: states.contains(WidgetState.selected) ? green : muted,);
        }),
      ),
      progressIndicatorTheme: const ProgressIndicatorThemeData(color: green),
    );
  }
}
