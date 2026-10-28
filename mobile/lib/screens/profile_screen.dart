import 'package:flutter/material.dart';

import '../models/models.dart';
import '../services/app_state.dart';
import '../services/server_address.dart';
import '../theme/theme.dart';
import '../widgets/common.dart' as ui;
import 'server_address_dialog.dart';

/// Who is signed in, and the way out.
class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key, required this.state});

  final AppState state;

  Future<void> _confirmSignOut(BuildContext context) async {
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext context) => AlertDialog(
        title: const Text('Sign out?'),
        content: const Text(
            'You will need your matric number and password to sign back in.',),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            style: TextButton.styleFrom(foregroundColor: UnnTheme.red),
            child: const Text('Sign out'),
          ),
        ],
      ),
    );
    if (confirmed ?? false) await state.signOut();
  }

  @override
  Widget build(BuildContext context) {
    final Student student = state.student!;

    return Scaffold(
      appBar: const ui.ScreenHeader(title: 'Profile'),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 28),
        children: <Widget>[
          ui.ForestCard(
            ringSize: 160,
            child: Row(
              children: <Widget>[
                Container(
                  width: 60,
                  height: 60,
                  alignment: Alignment.center,
                  decoration: const BoxDecoration(
                      color: UnnTheme.gold, shape: BoxShape.circle,),
                  child: Text(
                    student.initials,
                    style: const TextStyle(
                      color: UnnTheme.forest,
                      fontSize: 20,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        student.fullName,
                        style: const TextStyle(
                            fontSize: 18, fontWeight: FontWeight.w800,),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        student.matricNumber,
                        style: UnnTheme.monoStyle(
                            size: 13.5, color: UnnTheme.onForestMuted,),
                      ),
                    ],
                  ),
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
                  ui.DetailRow(label: 'Email', value: student.email),
                  ui.DetailRow(label: 'Department', value: student.department),
                  ui.DetailRow(
                    label: 'Level',
                    value:
                        student.level.isEmpty ? '—' : '${student.level} level',
                    last: true,
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 10),
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 4),
            child: Text(
              'These details come from the Bursary. If anything is wrong, ask them to correct it.',
              style: TextStyle(
                  fontSize: 12.5, color: UnnTheme.muted, height: 1.45,),
            ),
          ),
          if (ServerAddress.isConfigurable) ...<Widget>[
            const SizedBox(height: 14),
            Card(
              clipBehavior: Clip.antiAlias,
              child: ListTile(
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                leading: const ui.IconTile(icon: Icons.dns_outlined, size: 40),
                title: const Text(
                  'Server address',
                  style: TextStyle(fontWeight: FontWeight.w700, fontSize: 14.5),
                ),
                subtitle: Text(
                  state.api.baseUrl,
                  style: const TextStyle(fontSize: 12.5, color: UnnTheme.muted),
                ),
                trailing: const Icon(Icons.chevron_right_rounded,
                    color: UnnTheme.muted,),
                onTap: () => showServerAddressDialog(context, state),
              ),
            ),
          ],
          const SizedBox(height: 22),
          OutlinedButton.icon(
            onPressed: () => _confirmSignOut(context),
            style: OutlinedButton.styleFrom(
              foregroundColor: UnnTheme.red,
              side: const BorderSide(color: UnnTheme.redBg, width: 1.5),
              backgroundColor: Colors.white,
            ),
            icon: const Icon(Icons.logout_rounded),
            label: const Text('Sign out'),
          ),
          const SizedBox(height: 18),
          const Text(
            'UNN Pay · University of Nigeria, Nsukka',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, color: UnnTheme.muted),
          ),
        ],
      ),
    );
  }
}
