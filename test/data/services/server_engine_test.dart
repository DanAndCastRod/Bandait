import 'dart:async';

import 'package:test/test.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:mockito/mockito.dart';
import 'package:mockito/annotations.dart';

import 'package:bandait/data/services/server_engine.dart';
import 'package:bandait/domain/entities/client_session.dart';

// Since I cannot run `dart run build_runner build`, I will create a manual mock or use a fake.
// However, ServerEngine relies on `shelf_web_socket` which is hard to mock directly without dependency injection of the handler.
// But the `start` method starts a real server. I can write an integration test.

void main() {
  group('ServerEngine Integration Test', () {
    late ServerEngine serverEngine;
    final int port = 8080;
    final String address = 'localhost';

    setUp(() async {
      serverEngine = ServerEngine();
      await serverEngine.start(address, port);
    });

    tearDown(() async {
      await serverEngine.stop();
    });

    test('should register a client when connected', () async {
      final uri = Uri.parse('ws://$address:$port');
      final channel = WebSocketChannel.connect(uri);

      // Wait for connection to be established and processed by server
      await Future.delayed(Duration(milliseconds: 100));

      expect(serverEngine.connectedClients.length, 1);

      await channel.sink.close();
    });

    test('should unregister a client when disconnected', () async {
      final uri = Uri.parse('ws://$address:$port');
      final channel = WebSocketChannel.connect(uri);

      // Wait for connection
      await Future.delayed(Duration(milliseconds: 100));
      expect(serverEngine.connectedClients.length, 1);

      // Disconnect
      await channel.sink.close();

      // Wait for disconnection to be processed
      await Future.delayed(Duration(milliseconds: 100));
      expect(serverEngine.connectedClients.length, 0);
    });

    test('should handle multiple clients', () async {
      final uri = Uri.parse('ws://$address:$port');
      final channel1 = WebSocketChannel.connect(uri);
      final channel2 = WebSocketChannel.connect(uri);

      await Future.delayed(Duration(milliseconds: 100));
      expect(serverEngine.connectedClients.length, 2);

      await channel1.sink.close();
      await Future.delayed(Duration(milliseconds: 100));
      expect(serverEngine.connectedClients.length, 1);

      await channel2.sink.close();
      await Future.delayed(Duration(milliseconds: 100));
      expect(serverEngine.connectedClients.length, 0);
    });
  });
}
