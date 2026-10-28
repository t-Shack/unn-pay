import 'package:flutter/material.dart';

import '../config.dart';
import '../services/app_state.dart';
import '../services/server_address.dart';
import '../theme/theme.dart';

/// Change the server a demonstration build talks to.
///
/// Opened by a long press on the logo on the sign in screen, and only in a non
/// production build. Two ways to reach a laptop running the API:
///
///  * USB cable: `adb reverse tcp:4000 tcp:4000`, then http://127.0.0.1:4000
///  * Hotspot or shared Wi-Fi: the laptop's IP address, e.g. 192.168.43.10
Future<void> showServerAddressDialog(BuildContext context, AppState state) {
  return showDialog<void>(
    context: context,
    builder: (BuildContext context) => _ServerAddressDialog(state: state),
  );
}

class _ServerAddressDialog extends StatefulWidget {
  const _ServerAddressDialog({required this.state});

  final AppState state;

  @override
  State<_ServerAddressDialog> createState() => _ServerAddressDialogState();
}

class _ServerAddressDialogState extends State<_ServerAddressDialog> {
  late final TextEditingController _address =
      TextEditingController(text: widget.state.api.baseUrl);

  bool _checking = false;
  String? _problem;
  String? _unreachable;

  @override
  void dispose() {
    _address.dispose();
    super.dispose();
  }

  Future<void> _apply(String address) async {
    await ServerAddress.save(address);
    widget.state.api.useBaseUrl(address);
    if (!mounted) return;
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    Navigator.of(context).pop();
    messenger.showSnackBar(SnackBar(content: Text('Server set to $address')));
  }

  Future<void> _testAndSave() async {
    final String? address = ServerAddress.normalise(_address.text);
    if (address == null) {
      setState(() => _problem = 'Enter an address like 192.168.43.10 or http://127.0.0.1:4000');
      return;
    }
    setState(() {
      _checking = true;
      _problem = null;
      _unreachable = null;
    });
    final bool reachable = await ServerAddress.isReachable(address);
    if (!mounted) return;
    setState(() => _checking = false);
    if (reachable) {
      await _apply(address);
    } else {
      setState(() => _unreachable = address);
    }
  }

  Future<void> _reset() async {
    await ServerAddress.reset();
    widget.state.api.useBaseUrl(AppConfig.apiBaseUrl);
    if (!mounted) return;
    setState(() {
      _address.text = AppConfig.apiBaseUrl;
      _problem = null;
      _unreachable = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Server address'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            const Text(
              'USB cable: http://127.0.0.1:4000 (after adb reverse).\n'
              "Hotspot or Wi-Fi: the laptop's IP address, for example 192.168.43.10.",
              style: TextStyle(fontSize: 13, color: UnnTheme.muted, height: 1.45),
            ),
            const SizedBox(height: 14),
            TextField(
              controller: _address,
              keyboardType: TextInputType.url,
              autocorrect: false,
              decoration: InputDecoration(labelText: 'Address', errorText: _problem),
              onSubmitted: (_) => _testAndSave(),
            ),
            if (_unreachable != null) ...<Widget>[
              const SizedBox(height: 12),
              Text(
                'Could not reach UNN Pay at $_unreachable. Check the API is running on the '
                'laptop and that the phone and laptop are on the same network.',
                style: const TextStyle(fontSize: 13, color: UnnTheme.red, height: 1.4),
              ),
            ],
          ],
        ),
      ),
      actions: <Widget>[
        TextButton(onPressed: _checking ? null : _reset, child: const Text('Reset')),
        if (_unreachable != null)
          TextButton(
            onPressed: () => _apply(_unreachable!),
            child: const Text('Save anyway'),
          ),
        FilledButton(
          onPressed: _checking ? null : _testAndSave,
          child: _checking
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                )
              : const Text('Test and save'),
        ),
      ],
    );
  }
}
