import 'dart:io';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import 'api_client.dart';

/// Firebase Cloud Messaging (§3, §11.5).
///
/// Push is how a student learns their payment landed without staring at the
/// screen. It is a convenience, never the source of truth: the payment screen
/// polls as well (§11.3), and the server's record is authoritative regardless.
/// So every failure here is swallowed — a student with notifications denied
/// must still be able to use the app completely.
class PushService {
  PushService({required this.api});

  final ApiClient api;

  static const AndroidNotificationChannel _channel = AndroidNotificationChannel(
    'unn_pay_payments',
    'Payments',
    description: 'Payment confirmations and alerts about payments needing attention',
    importance: Importance.high,
  );

  final FlutterLocalNotificationsPlugin _local = FlutterLocalNotificationsPlugin();
  String? _token;

  /// Notifications the app has received while open, so the home screen can show
  /// an alert without waiting for the next poll.
  final ValueNotifier<RemoteMessage?> lastMessage = ValueNotifier<RemoteMessage?>(null);

  Future<void> initialise() async {
    try {
      await _local.initialize(
        const InitializationSettings(
          android: AndroidInitializationSettings('@mipmap/ic_launcher'),
          iOS: DarwinInitializationSettings(),
        ),
      );

      await _local
          .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
          ?.createNotificationChannel(_channel);

      await FirebaseMessaging.instance.requestPermission();

      FirebaseMessaging.onMessage.listen(_onForegroundMessage);
      FirebaseMessaging.instance.onTokenRefresh.listen((String token) {
        _token = token;
        registerWithBackend();
      });
    } catch (error) {
      debugPrint('Push unavailable: $error');
    }
  }

  void _onForegroundMessage(RemoteMessage message) {
    lastMessage.value = message;

    final RemoteNotification? notification = message.notification;
    if (notification == null) return;

    // Android does not display a notification while the app is foregrounded,
    // so it is raised locally.
    _local.show(
      notification.hashCode,
      notification.title,
      notification.body,
      NotificationDetails(
        android: AndroidNotificationDetails(
          _channel.id,
          _channel.name,
          channelDescription: _channel.description,
          importance: Importance.high,
          priority: Priority.high,
        ),
        iOS: const DarwinNotificationDetails(),
      ),
    );
  }

  Future<void> registerWithBackend() async {
    try {
      _token ??= await FirebaseMessaging.instance.getToken();
      if (_token == null) return;
      await api.registerDevice(
        token: _token!,
        platform: Platform.isIOS ? 'ios' : 'android',
      );
    } catch (error) {
      debugPrint('Could not register device for push: $error');
    }
  }

  Future<void> unregister() async {
    try {
      if (_token != null) await api.unregisterDevice(_token!);
      await FirebaseMessaging.instance.deleteToken();
      _token = null;
    } catch (error) {
      debugPrint('Could not unregister device: $error');
    }
  }
}
