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
  TextEditingValue formatEditUpdate(
      TextEditingValue oldValue, TextEditingValue newValue,) {
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

  void _openOtpFlow(OtpFlowMode mode) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => OtpFlowScreen(state: widget.state, mode: mode),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: UnnTheme.forest,
      body: Stack(
        children: <Widget>[
          const Positioned(
              left: -120,
              top: -140,
              child: ui.GoldRing(size: 340, opacity: 0.09),),
          Positioned(
            right: -60,
            top: 170,
            child: IgnorePointer(
              child: Container(
                width: 170,
                height: 170,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border:
                      Border.all(color: Colors.white.withValues(alpha: 0.12)),
                ),
              ),
            ),
          ),
          SafeArea(
            bottom: false,
            child: CustomScrollView(
              slivers: <Widget>[
                SliverFillRemaining(
                  hasScrollBody: false,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      Padding(
                        padding: const EdgeInsets.fromLTRB(28, 28, 28, 28),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            // A demonstration build can be pointed at another
                            // server from here; a production build cannot.
                            GestureDetector(
                              onLongPress: ServerAddress.isConfigurable
                                  ? () => showServerAddressDialog(
                                      context, widget.state,)
                                  : null,
                              child: const _Brand(),
                            ),
                            const SizedBox(height: 22),
                            const Text.rich(
                              TextSpan(
                                text: 'School fees,\n',
                                children: <InlineSpan>[
                                  TextSpan(
                                    text: 'paid in minutes.',
                                    style: TextStyle(color: UnnTheme.gold),
                                  ),
                                ],
                              ),
                              style: TextStyle(
                                color: Colors.white,
                                fontSize: 30,
                                height: 1.15,
                                fontWeight: FontWeight.w800,
                                letterSpacing: -0.8,
                              ),
                            ),
                            const SizedBox(height: 10),
                            const Text(
                              'Pay straight into the University\'s account from any bank app, '
                              'and get a signed receipt the moment it lands.',
                              style: TextStyle(
                                color: UnnTheme.onForestMuted,
                                fontSize: 14,
                                height: 1.5,
                              ),
                            ),
                          ],
                        ),
                      ),
                      Expanded(
                        child: Container(
                          decoration: const BoxDecoration(
                            color: Colors.white,
                            borderRadius:
                                BorderRadius.vertical(top: Radius.circular(32)),
                          ),
                          padding: const EdgeInsets.fromLTRB(24, 26, 24, 24),
                          child: SafeArea(top: false, child: _buildForm()),
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
    );
  }

  Widget _buildForm() {
    return Form(
      key: _form,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          const Text(
            'Welcome back',
            style: TextStyle(
                fontSize: 22, fontWeight: FontWeight.w800, letterSpacing: -0.4,),
          ),
          const SizedBox(height: 4),
          const Text(
            'Sign in with your matric number.',
            style: TextStyle(fontSize: 14, color: UnnTheme.muted),
          ),
          const SizedBox(height: 18),
          if (_error != null) ...<Widget>[
            ui.NoticeBanner(message: _error!, tone: ui.StatusTone.danger),
            const SizedBox(height: 14),
          ],
          TextFormField(
            controller: _matric,
            decoration: const InputDecoration(
              labelText: 'Matric number',
              hintText: '2022/248400',
              prefixIcon: Icon(Icons.badge_outlined),
            ),
            style: const TextStyle(
                fontSize: 16, fontWeight: FontWeight.w600, letterSpacing: 0.3,),
            keyboardType: TextInputType.number,
            inputFormatters: <TextInputFormatter>[_MatricFormatter()],
            textInputAction: TextInputAction.next,
            validator: (String? value) =>
                _matricPattern.hasMatch(value?.trim() ?? '')
                    ? null
                    : 'Enter your matric number, like 2022/248400',
          ),
          const SizedBox(height: 14),
          TextFormField(
            controller: _password,
            obscureText: _obscure,
            decoration: InputDecoration(
              labelText: 'Password',
              prefixIcon: const Icon(Icons.lock_outline_rounded),
              suffixIcon: IconButton(
                tooltip: _obscure ? 'Show password' : 'Hide password',
                icon: Icon(_obscure
                    ? Icons.visibility_rounded
                    : Icons.visibility_off_rounded,),
                onPressed: () => setState(() => _obscure = !_obscure),
              ),
            ),
            onFieldSubmitted: (_) => _submit(),
            validator: (String? value) =>
                (value ?? '').isEmpty ? 'Enter your password' : null,
          ),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(
              onPressed: () => _openOtpFlow(OtpFlowMode.resetPassword),
              child: const Text('Forgot password?'),
            ),
          ),
          FilledButton(
            onPressed: _busy ? null : _submit,
            child: _busy
                ? const ui.ButtonSpinner()
                : const Row(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Text('Sign in'),
                      SizedBox(width: 8),
                      Icon(Icons.arrow_forward_rounded, size: 20),
                    ],
                  ),
          ),
          const SizedBox(height: 18),
          const Row(
            children: <Widget>[
              Expanded(child: Divider(color: UnnTheme.line)),
              Padding(
                padding: EdgeInsets.symmetric(horizontal: 12),
                child: Text(
                  'First time here?',
                  style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                    color: UnnTheme.muted,
                  ),
                ),
              ),
              Expanded(child: Divider(color: UnnTheme.line)),
            ],
          ),
          const SizedBox(height: 18),
          OutlinedButton(
            onPressed: () => _openOtpFlow(OtpFlowMode.activate),
            child: const Text('Activate my account'),
          ),
          const SizedBox(height: 16),
          const Text(
            'Your matric number must already be registered with the Bursary. If it is '
            'not recognised, speak to the Bursary Department.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, color: UnnTheme.muted, height: 1.5),
          ),
        ],
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
  String get _title =>
      _isActivation ? 'Activate your account' : 'Reset your password';

  @override
  void initState() {
    super.initState();
    // The code boxes and the password checklist redraw as the student types.
    _code.addListener(_redraw);
    _password.addListener(_redraw);
    _confirm.addListener(_redraw);
  }

  void _redraw() {
    if (mounted) setState(() {});
  }

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
        _info =
            'If that matric number is registered, a 6 digit code has been sent to the email '
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
      setState(() => _error =
          'Your password must contain at least one letter and one number',);
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
    final String primaryLabel = _step == 0
        ? 'Send me a code'
        : (_isActivation ? 'Activate account' : 'Change password');

    return Scaffold(
      appBar: ui.ScreenHeader(
        title: _title,
        actions: <Widget>[
          Text(
            'Step ${_step + 1} of 2',
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w700,
              color: UnnTheme.muted,
            ),
          ),
        ],
      ),
      // The one action stays in reach at the bottom, whatever the step.
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
          child: FilledButton(
            onPressed: _busy ? null : (_step == 0 ? _requestCode : _submit),
            child: _busy ? const ui.ButtonSpinner() : Text(primaryLabel),
          ),
        ),
      ),
      body: SafeArea(
        top: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Row(
                children: <Widget>[
                  Expanded(child: _progress(UnnTheme.green)),
                  const SizedBox(width: 8),
                  Expanded(
                      child: _progress(
                          _step == 1 ? UnnTheme.gold : UnnTheme.line,),),
                ],
              ),
              const SizedBox(height: 24),
              const ui.IconTile(
                icon: Icons.mark_email_unread_outlined,
                size: 56,
                background: UnnTheme.forest,
                foreground: UnnTheme.gold,
              ),
              const SizedBox(height: 14),
              Text(
                _step == 0 ? 'Find your record' : 'Check your email',
                style: const TextStyle(
                  fontSize: 25,
                  fontWeight: FontWeight.w800,
                  letterSpacing: -0.6,
                ),
              ),
              const SizedBox(height: 8),
              if (_step == 0)
                Text(
                  _isActivation
                      ? 'Enter the matric number the Bursary registered for you. We will email a '
                          'code to the address they have on file.'
                      : 'Enter your matric number and we will email you a reset code.',
                  style: const TextStyle(
                      color: UnnTheme.muted, height: 1.5, fontSize: 14.5,),
                ),
              const SizedBox(height: 18),
              if (_error != null) ...<Widget>[
                ui.NoticeBanner(message: _error!, tone: ui.StatusTone.danger),
                const SizedBox(height: 14),
              ],
              if (_info != null && _step == 1) ...<Widget>[
                ui.NoticeBanner(message: _info!, tone: ui.StatusTone.good),
                const SizedBox(height: 18),
              ],
              if (_step == 0)
                TextFormField(
                  controller: _matric,
                  autofocus: true,
                  decoration: const InputDecoration(
                    labelText: 'Matric number',
                    hintText: '2022/248400',
                    prefixIcon: Icon(Icons.badge_outlined),
                  ),
                  style: const TextStyle(
                      fontSize: 16, fontWeight: FontWeight.w600,),
                  keyboardType: TextInputType.number,
                  inputFormatters: <TextInputFormatter>[_MatricFormatter()],
                  onFieldSubmitted: (_) => _requestCode(),
                )
              else ...<Widget>[
                const Text(
                  'Code from your email',
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 10),
                _CodeBoxes(controller: _code),
                Align(
                  alignment: Alignment.centerRight,
                  child: TextButton(
                    onPressed: _busy ? null : _requestCode,
                    child: const Text('Send the code again'),
                  ),
                ),
                TextFormField(
                  controller: _password,
                  obscureText: true,
                  decoration: InputDecoration(
                    labelText:
                        _isActivation ? 'Choose a password' : 'New password',
                    prefixIcon: const Icon(Icons.lock_outline_rounded),
                  ),
                ),
                const SizedBox(height: 10),
                _PasswordStrength(password: _password.text),
                const SizedBox(height: 16),
                TextFormField(
                  controller: _confirm,
                  obscureText: true,
                  decoration: InputDecoration(
                    labelText: 'Confirm password',
                    prefixIcon: const Icon(Icons.lock_outline_rounded),
                    suffixIcon: _confirm.text.isNotEmpty &&
                            _confirm.text == _password.text
                        ? const Icon(Icons.check_rounded, color: UnnTheme.green)
                        : null,
                  ),
                  onFieldSubmitted: (_) => _submit(),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _progress(Color color) => Container(
        height: 5,
        decoration: BoxDecoration(
            color: color, borderRadius: BorderRadius.circular(999),),
      );
}

/// Six boxes showing the code as it is typed. A real text field sits on top,
/// invisible, so paste, autofill from SMS and the system keyboard all work.
class _CodeBoxes extends StatelessWidget {
  const _CodeBoxes({required this.controller});

  final TextEditingController controller;

  @override
  Widget build(BuildContext context) {
    final String code = controller.text;
    return SizedBox(
      height: 58,
      child: Stack(
        children: <Widget>[
          Row(
            children: List<Widget>.generate(6, (int index) {
              final bool filled = index < code.length;
              final bool active = index == code.length;
              return Expanded(
                child: Container(
                  margin: EdgeInsets.only(right: index == 5 ? 0 : 8),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(
                      color: active ? UnnTheme.green : UnnTheme.line,
                      width: active ? 2 : 1.5,
                    ),
                  ),
                  child: Text(
                    filled ? code[index] : '',
                    style: UnnTheme.monoStyle(size: 24, color: UnnTheme.ink),
                  ),
                ),
              );
            }),
          ),
          Positioned.fill(
            child: Opacity(
              opacity: 0,
              child: TextFormField(
                controller: controller,
                autofocus: true,
                keyboardType: TextInputType.number,
                maxLength: 6,
                showCursor: false,
                enableInteractiveSelection: false,
                autofillHints: const <String>[AutofillHints.oneTimeCode],
                decoration: const InputDecoration(
                    counterText: '', border: InputBorder.none,),
                inputFormatters: <TextInputFormatter>[
                  FilteringTextInputFormatter.digitsOnly,
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _PasswordStrength extends StatelessWidget {
  const _PasswordStrength({required this.password});

  final String password;

  @override
  Widget build(BuildContext context) {
    final bool longEnough = password.length >= 8;
    final bool mixed = RegExp(r'[a-zA-Z]').hasMatch(password) &&
        RegExp(r'\d').hasMatch(password);
    final bool strong = password.length >= 12;
    final int score = <bool>[password.isNotEmpty, longEnough, mixed, strong]
        .where((bool b) => b)
        .length;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Row(
          children: List<Widget>.generate(4, (int index) {
            return Expanded(
              child: Container(
                height: 4,
                margin: EdgeInsets.only(right: index == 3 ? 0 : 6),
                decoration: BoxDecoration(
                  color: index < score ? UnnTheme.green : UnnTheme.line,
                  borderRadius: BorderRadius.circular(999),
                ),
              ),
            );
          }),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 14,
          runSpacing: 4,
          children: <Widget>[
            _rule('8 or more characters', longEnough),
            _rule('A letter and a number', mixed),
          ],
        ),
      ],
    );
  }

  Widget _rule(String label, bool met) {
    final Color color = met ? UnnTheme.greenDark : UnnTheme.muted;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Icon(
          met
              ? Icons.check_circle_rounded
              : Icons.radio_button_unchecked_rounded,
          size: 15,
          color: color,
        ),
        const SizedBox(width: 5),
        Text(label,
            style: TextStyle(
                fontSize: 12.5, fontWeight: FontWeight.w600, color: color,),),
      ],
    );
  }
}

class _Brand extends StatelessWidget {
  const _Brand();

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        Container(
          width: 44,
          height: 44,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: UnnTheme.gold,
            borderRadius: BorderRadius.circular(14),
          ),
          child: const Text(
            'U',
            style: TextStyle(
              color: UnnTheme.forest,
              fontSize: 23,
              fontWeight: FontWeight.w800,
            ),
          ),
        ),
        const SizedBox(width: 12),
        const Flexible(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                'UNN Pay',
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 19,
                  fontWeight: FontWeight.w800,
                  letterSpacing: -0.3,
                ),
              ),
              Text(
                'University of Nigeria, Nsukka',
                style: TextStyle(
                  color: UnnTheme.onForestMuted,
                  fontSize: 12.5,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
