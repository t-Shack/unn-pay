import 'package:flutter_test/flutter_test.dart';
import 'package:unn_pay/services/server_address.dart';

void main() {
  group('ServerAddress.normalise', () {
    test('accepts a bare IP and assumes the API port', () {
      expect(ServerAddress.normalise('192.168.43.10'), 'http://192.168.43.10:4000');
    });

    test('keeps an explicit port and drops a trailing slash or path', () {
      expect(ServerAddress.normalise(' 192.168.43.10:4000/ '), 'http://192.168.43.10:4000');
      expect(ServerAddress.normalise('http://127.0.0.1:4000/api'), 'http://127.0.0.1:4000');
    });

    test('leaves default ports off', () {
      expect(ServerAddress.normalise('https://pay.unn.edu.ng'), 'https://pay.unn.edu.ng');
      expect(ServerAddress.normalise('http://demo.local:80'), 'http://demo.local');
    });

    test('rejects what is not an address', () {
      expect(ServerAddress.normalise(''), isNull);
      expect(ServerAddress.normalise('ftp://192.168.43.10'), isNull);
      expect(ServerAddress.normalise('http://'), isNull);
    });
  });
}
