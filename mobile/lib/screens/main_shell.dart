import 'package:flutter/material.dart';

import '../services/app_state.dart';
import '../theme/theme.dart';
import 'history_screen.dart';
import 'home_screen.dart';
import 'profile_screen.dart';

/// The signed in app: four tabs behind a bottom navigation bar.
///
/// Tabs are rebuilt when they are opened, so History and Receipts always show
/// the latest payments without the student having to pull to refresh.
class MainShell extends StatefulWidget {
  const MainShell({super.key, required this.state});

  final AppState state;

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> {
  int _index = 0;

  void _go(int index) => setState(() => _index = index);

  @override
  Widget build(BuildContext context) {
    final Widget body = switch (_index) {
      HomeTab.history => HistoryScreen(
          key: const ValueKey<String>('history'), state: widget.state,),
      HomeTab.receipts => HistoryScreen(
          key: const ValueKey<String>('receipts'),
          state: widget.state,
          receiptsOnly: true,
        ),
      3 => ProfileScreen(state: widget.state),
      _ => HomeScreen(state: widget.state, onOpenTab: _go),
    };

    return Scaffold(
      body: body,
      bottomNavigationBar: DecoratedBox(
        decoration: const BoxDecoration(
          border: Border(top: BorderSide(color: UnnTheme.line)),
        ),
        child: NavigationBar(
          selectedIndex: _index,
          onDestinationSelected: _go,
          destinations: const <NavigationDestination>[
            NavigationDestination(
              icon: Icon(Icons.home_outlined),
              selectedIcon: Icon(Icons.home_rounded),
              label: 'Home',
            ),
            NavigationDestination(
              icon: Icon(Icons.history_rounded),
              label: 'History',
            ),
            NavigationDestination(
              icon: Icon(Icons.receipt_long_outlined),
              selectedIcon: Icon(Icons.receipt_long_rounded),
              label: 'Receipts',
            ),
            NavigationDestination(
              icon: Icon(Icons.person_outline_rounded),
              selectedIcon: Icon(Icons.person_rounded),
              label: 'Profile',
            ),
          ],
        ),
      ),
    );
  }
}
