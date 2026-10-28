import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../services/api_client.dart';
import '../services/app_state.dart';
import '../services/server_address.dart';
import '../theme/theme.dart';
import '../widgets/common.dart' as ui;
import 'server_address_dialog.dart';

/// Sign in and account activation (§11.1).
///
/// Registration is not open: a student can only activate an account the Bursary
/// has already imported. The screens say so plainly, because a student who does
/// not understand why they cannot register will assume the app is broken.

/// Formats a matric number as the student types: 2022/248400.
class _MatricFormatter extends TextInputFormatter {
  @override
  TextEditingValue formatEditUpdate(TextEditingValue oldValue, TextEditingValue newValue) {
    final String digits = newValue.text.replaceAll(RegExp(r'[^0-9]'), '');
    final String formatted = digits.length <= 4
        ? digits
        : '${digits.substring(0, 4)}/${digits.substring(4, digits.length.clamp(4, 10))}';
    return TextEditingValue(
      text: formatted,
      selection: TextSelection.collapsed(offset: formatted.length),
    );
  }
}

final RegExp _matricPattern = RegExp(r'^\d{4}/\d{6}$');

class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key, required this.state});

  final AppState state;

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  final GlobalKey<FormState> _form = GlobalKey<FormState>();
  final TextEditingController _matric = TextEditingController();
  final TextEditingController _password = TextEditingController();

  bool _busy = false;
  bool _obscure = true;
  String? _error;

  @override
  void dispose() {
    _matric.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.state.signIn(
        matricNumber: _matric.text.trim(),
        password: _password.text,
      );
    } on ApiException catch (error) {
      if (mounted) {
        setState(() {
          _error = error.code == 'account_not_activated'
              ? 'This account has not been activated yet. Tap "Activate my account" below.'
              : error.message;
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Form(
                key: _form,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    const SizedBox(height: 20),
                    // A demonstration build can be pointed at another server
                    // from here; a production build cannot.
                    GestureDetector(
                      onLongPress: ServerAddress.isConfigurable
                          ? () => showServerAddressDialog(context, widget.state)
                          : null,
                      child: const _Brand(),
                    ),
                    const SizedBox(height: 32),
                    if (_error != null) ...<Widget>[
                      ui.NoticeBanner(message: _error!, tone: ui.StatusTone.danger),
                      const SizedBox(height: 16),
                    ],
                    TextFormField(
                      controller: _matric,
                      decoration: const InputDecoration(
                        labelText: 'Matric number',
                        hintText: '2022/248400',
                      ),
                      keyboardType: TextInputType.number,
                      inputFormatters: <TextInputFormatter>[_MatricFormatter()],
                      textInputAction: TextInputAction.next,
                      validator: (String? value) => _matricPattern.hasMatch(value?.trim() ?? '')
                          ? null
                          : 'Enter your matric number, like 2022/248400',
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: _password,
                      obscureText: _obscure,
                      decoration: InputDecoration(
                        labelText: 'Password',
                        suffixIcon: IconButton(
                          icon: Icon(
                            _obscure ? Icons.visibility_rounded : Icons.visibility_off_rounded,
                          ),
                          onPressed: () => setState(() => _obscure = !_obscure),
                        ),
                      ),
                      onFieldSubmitted: (_) => _submit(),
                      validator: (String? value) =>
                          (value ?? '').isEmpty ? 'Enter your password' : null,
                    ),
                    const SizedBox(height: 22),
                    FilledButton(
                      onPressed: _busy ? null : _submit,
                      child: _busy
                          ? const SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Colors.white,
                              ),
                            )
                          : const Text('Sign in'),
                    ),
                    const SizedBox(height: 10),
                    TextButton(
                      onPressed: () => Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => OtpFlowScreen(
                            state: widget.state,
                            mode: OtpFlowMode.resetPassword,
                          ),
                        ),
                      ),
                      child: const Text('Forgot my password'),
                    ),
                    const Divider(height: 34),
                    OutlinedButton(
                      onPressed: () => Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => OtpFlowScreen(
                            state: widget.state,
                            mode: OtpFlowMode.activate,
                          ),
                        ),
                      ),
                      child: const Text('Activate my account'),
                    ),
                    const SizedBox(height: 14),
                    const Text(
                      'Your matric number must already be registered with the Bursary. If it is '
                      'not recognised, speak to the Bursary Department.',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 12.5, color: UnnTheme.muted, height: 1.5),
                    ),
                    const SizedBox(height: 20),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

enum OtpFlowMode { activate, resetPassword }

/// One screen for both OTP flows: they differ only in wording and the two
/// endpoints they call, so duplicating the whole thing would just be two places
/// to fix the same bug.
class OtpFlowScreen extends StatefulWidget {
  const OtpFlowScreen({super.key, required this.state, required this.mode});

  final AppState state;
  final OtpFlowMode mode;

  @override
  State<OtpFlowScreen> createState() => _OtpFlowScreenState();
}

class _OtpFlowScreenState extends State<OtpFlowScreen> {
  final TextEditingController _matric = TextEditingController();
  final TextEditingController _code = TextEditingController();
  final TextEditingController _password = TextEditingController();
  final TextEditingController _confirm = TextEditingController();

  int _step = 0;
  bool _busy = false;
  String? _error;
  String? _info;

  bool get _isActivation => widget.mode == OtpFlowMode.activate;
  String get _title => _isActivation ? 'Activate your account' : 'Reset your password';

  @override
  void dispose() {
    _matric.dispose();
    _code.dispose();
    _password.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _requestCode() async {
    final String matric = _matric.text.trim();
    if (!_matricPattern.hasMatch(matric)) {
      setState(() => _error = 'Enter your matric number, like 2022/248400');
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      if (_isActivation) {
        await widget.state.api.requestActivation(matric);
      } else {
        await widget.state.api.forgotPassword(matric);
      }
      if (!mounted) return;
      setState(() {
        _step = 1;
        // Deliberately non committal: the API does not confirm whether the
        // matric number exists, and neither does this screen.
        _info = 'If that matric number is registered, a 6 digit code has been sent to the email '
            'address the Bursary has on file. It expires in 15 minutes.';
      });
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _submit() async {
    if (_code.text.trim().length != 6) {
      setState(() => _error = 'Enter the 6 digit code from your email');
      return;
    }
    if (_password.text.length < 8) {
      setState(() => _error = 'Your password must be at least 8 characters');
      return;
    }
    if (!RegExp(r'[a-zA-Z]').hasMatch(_password.text) ||
        !RegExp(r'\d').hasMatch(_password.text)) {
      setState(() => _error = 'Your password must contain at least one letter and one number');
      return;
    }
    if (_password.text != _confirm.text) {
      setState(() => _error = 'The two passwords do not match');
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      if (_isActivation) {
        await widget.state.activate(
          matricNumber: _matric.text.trim(),
          code: _code.text.trim(),
          password: _password.text,
        );
        if (mounted) Navigator.of(context).pop();
      } else {
        await widget.state.api.resetPassword(
          matricNumber: _matric.text.trim(),
          code: _code.text.trim(),
          password: _password.text,
        );
        if (!mounted) return;
        Navigator.of(context).pop();
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Password changed. Please sign in.')),
        );
      }
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_title)),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                if (_error != null) ...<Widget>[
                  ui.NoticeBanner(message: _error!, tone: ui.StatusTone.danger),
                  const SizedBox(height: 16),
                ],
                if (_info != null && _step == 1) ...<Widget>[
                  ui.NoticeBanner(message: _info!, tone: ui.StatusTone.good),
                  const SizedBox(height: 16),
                ],
                if (_step == 0) ...<Widget>[
                  Text(
                    _isActivation
                        ? 'Enter the matric number the Bursary registered for you. We will email a '
                            'code to the address they have on file.'
                        : 'Enter your matric number and we will email you a reset code.',
                    style: const TextStyle(color: UnnTheme.muted, height: 1.5),
                  ),
                  const SizedBox(height: 20),
                  TextFormField(
                    controller: _matric,
                    autofocus: true,
                    decoration: const InputDecoration(
                      labelText: 'Matric number',
                      hintText: '2022/248400',
                    ),
                    keyboardType: TextInputType.number,
                    inputFormatters: <TextInputFormatter>[_MatricFormatter()],
                  ),
                  const SizedBox(height: 22),
                  FilledButton(
                    onPressed: _busy ? null : _requestCode,
                    child: _busy
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                          )
                        : const Text('Send me a code'),
                  ),
                ] else ...<Widget>[
                  TextFormField(
                    controller: _code,
                    autofocus: true,
                    decoration: const InputDecoration(
                      labelText: '6 digit code',
                      hintText: '123456',
                    ),
                    keyboardType: TextInputType.number,
                    maxLength: 6,
                    style: const TextStyle(fontSize: 22, letterSpacing: 8),
                    textAlign: TextAlign.center,
                    inputFormatters: <TextInputFormatter>[FilteringTextInputFormatter.digitsOnly],
                  ),
                  const SizedBox(height: 6),
                  TextFormField(
                    controller: _password,
                    obscureText: true,
                    decoration: InputDecoration(
                      labelText: _isActivation ? 'Choose a password' : 'New password',
                      helperText: 'At least 8 characters, with a letter and a number',
                    ),
                  ),
                  const SizedBox(height: 18),
                  TextFormField(
                    controller: _confirm,
                    obscureText: true,
                    decoration: const InputDecoration(labelText: 'Confirm password'),
                    onFieldSubmitted: (_) => _submit(),
                  ),
                  const SizedBox(height: 22),
                  FilledButton(
                    onPressed: _busy ? null : _submit,
                    child: _busy
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                          )
                        : Text(_isActivation ? 'Activate account' : 'Change password'),
                  ),
                  const SizedBox(height: 10),
                  TextButton(
                    onPressed: _busy ? null : _requestCode,
                    child: const Text('Send the code again'),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Brand extends StatelessWidget {
  const _Brand();

  @override
  Widget build(BuildContext context) {
    return Column(
      children: <Widget>[
        Container(
          width: 62,
          height: 62,
          decoration: BoxDecoration(
            color: UnnTheme.green,
            borderRadius: BorderRadius.circular(16),
          ),
          child: const Icon(Icons.school_rounded, color: Colors.white, size: 32),
        ),
        const SizedBox(height: 16),
        const Text(
          'UNN Pay',
          style: TextStyle(fontSize: 25, fontWeight: FontWeight.w700, letterSpacing: -0.5),
        ),
        const SizedBox(height: 4),
        const Text(
          'University of Nigeria, Nsukka',
          style: TextStyle(color: UnnTheme.muted, fontSize: 13.5),
        ),
      ],
    );
  }
}
