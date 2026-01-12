import 'dart:async';

import 'package:bandait/data/datasources/remote/websocket_client_engine.dart';
import 'package:bandait/domain/enums/connection_status.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mockito/mockito.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:web_socket_channel/status.dart' as status;

// Manual Mock since we can't run build_runner
class MockWebSocketChannel extends Mock implements WebSocketChannel {
  final StreamController _streamController = StreamController.broadcast();
  final MockWebSocketSink _sink = MockWebSocketSink();

  @override
  Stream get stream => _streamController.stream;

  @override
  WebSocketSink get sink => _sink;

  void emit(dynamic data) {
    _streamController.add(data);
  }

  void emitError(dynamic error) {
    _streamController.addError(error);
  }

  void closeStream() {
    _streamController.close();
  }
}

class MockWebSocketSink extends Mock implements WebSocketSink {
  final List<dynamic> sentMessages = [];
  bool isClosed = false;

  @override
  void add(dynamic data) {
    sentMessages.add(data);
  }

  @override
  Future close([int? closeCode, String? closeReason]) async {
    isClosed = true;
    return;
  }
}

void main() {
  group('WebSocketClientEngine', () {
    late WebSocketClientEngine engine;
    late MockWebSocketChannel mockChannel;
    late StreamController<dynamic> channelStreamController;

    setUp(() {
      mockChannel = MockWebSocketChannel();
      engine = WebSocketClientEngine(
        channelFactory: (uri) => mockChannel,
      );
    });

    tearDown(() {
      engine.dispose();
      mockChannel.closeStream();
    });

    test('Initial status is disconnected', () {
      expect(engine.currentStatus, ConnectionStatus.disconnected);
    });

    test('Connect updates status to connecting then connected on success', () async {
      final statusList = <ConnectionStatus>[];
      final subscription = engine.connectionStatus.listen(statusList.add);

      await engine.connect('ws://localhost:8080');

      // The engine assumes connected if no error immediately,
      // but strictly speaking it waits for stream listen.
      // In our implementation:
      // _updateStatus(ConnectionStatus.connecting);
      // _channelSubscription = ...
      // _updateStatus(ConnectionStatus.connected); (optimistic)

      expect(engine.currentStatus, ConnectionStatus.connected);
      expect(statusList, contains(ConnectionStatus.connecting));
      expect(statusList, contains(ConnectionStatus.connected));

      subscription.cancel();
    });

    test('Receiving message emits to messages stream', () async {
      await engine.connect('ws://localhost:8080');

      final messages = [];
      final subscription = engine.messages.listen(messages.add);

      mockChannel.emit('Hello');

      // Wait for stream to propagate
      await Future.delayed(Duration.zero);

      expect(messages, equals(['Hello']));
      subscription.cancel();
    });

    test('Send message writes to sink', () async {
      await engine.connect('ws://localhost:8080');

      engine.send('Ping');

      final sink = mockChannel.sink as MockWebSocketSink;
      expect(sink.sentMessages, contains('Ping'));
    });

    test('Disconnect closes channel and updates status', () async {
      await engine.connect('ws://localhost:8080');

      await engine.disconnect();

      expect(engine.currentStatus, ConnectionStatus.disconnected);
      final sink = mockChannel.sink as MockWebSocketSink;
      expect(sink.isClosed, isTrue);
    });

    // Reconnection logic requires waiting for timer, which is hard with real Timer.
    // Ideally we would inject a scheduler, but for now we can rely on FakeAsync if available,
    // or just trust the logic if we can't run tests here.
  });
}
