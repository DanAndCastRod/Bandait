import 'package:flutter_test/flutter_test.dart';
import 'package:bandait/data/network/socket_service.dart';
import 'dart:async';

void main() {
  group('Socket Integration Tests', () {
    late SocketServer server;
    late SocketClient client;

    setUpAll(() async {
      server = SocketServer();
      await server.start(0); // Let OS pick a free port
    });

    tearDownAll(() async {
      await server.stop();
    });

    setUp(() {
      client = SocketClient();
    });

    tearDown(() async {
      await client.disconnect();
    });

    test('Client can connect to Server and handshake', () async {
      final connectionCompleter = Completer<void>();

      client.onConnectionStatusChanged.listen((status) {
        if (status && !connectionCompleter.isCompleted)
          connectionCompleter.complete();
      });

      await client.connect('127.0.0.1', server.port);
      await connectionCompleter.future;

      expect(client.isConnected, isTrue);
    });

    test('Client receives PONG after sending PING (Latency Test)', () async {
      await client.connect('127.0.0.1', server.port);

      final latencyCompleter = Completer<int>();
      client.latencyStream.listen((latency) {
        if (!latencyCompleter.isCompleted) {
          latencyCompleter.complete(latency);
        }
      });

      client.ping();

      final latency = await latencyCompleter.future.timeout(
        const Duration(seconds: 2),
      );
      print('Measured latency: ${latency}ms');
      expect(latency, greaterThanOrEqualTo(0));
    });

    test('Server broadcasts message to connected client', () async {
      final messageCompleter = Completer<String>();
      await client.connect('127.0.0.1', server.port);

      client.onDataReceived.listen((msg) {
        if (!messageCompleter.isCompleted) messageCompleter.complete(msg);
      });

      // Verification: Wait a bit for connection to be fully registered on server side before broadcast
      await Future.delayed(const Duration(milliseconds: 100));

      server.broadcast('TEST_MESSAGE');

      final received = await messageCompleter.future.timeout(
        const Duration(seconds: 2),
      );
      expect(received, equals('TEST_MESSAGE'));
    });
  });
}
