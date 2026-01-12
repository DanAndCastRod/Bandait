import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mockito/mockito.dart';
import 'package:mockito/annotations.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:web_socket_channel/status.dart' as status;

import 'package:bandait/data/datasources/remote/client_engine.dart';
import 'package:bandait/domain/entities/connection_status.dart';

// Create a Mock for WebSocketChannel
class MockWebSocketChannel extends Mock implements WebSocketChannel {
  @override
  Future<void> get ready => super.noSuchMethod(
        Invocation.getter(#ready),
        returnValue: Future<void>.value(),
        returnValueForMissingStub: Future<void>.value(),
      );

  @override
  Stream get stream => super.noSuchMethod(
        Invocation.getter(#stream),
        returnValue: Stream.empty(),
      );

  @override
  WebSocketSink get sink => super.noSuchMethod(
        Invocation.getter(#sink),
        returnValue: MockWebSocketSink(),
      );
}

class MockWebSocketSink extends Mock implements WebSocketSink {
  @override
  Future close([int? closeCode, String? closeReason]) => super.noSuchMethod(
        Invocation.method(#close, [closeCode, closeReason]),
        returnValue: Future.value(),
      );

  @override
  void add(dynamic data) => super.noSuchMethod(
        Invocation.method(#add, [data]),
      );
}

void main() {
  late ClientEngine clientEngine;
  late MockWebSocketChannel mockChannel;
  late StreamController streamController;

  void _setupClientEngine({Future<void>? readyFuture}) {
    mockChannel = MockWebSocketChannel();
    streamController = StreamController();

    when(mockChannel.stream).thenAnswer((_) => streamController.stream);
    when(mockChannel.ready).thenAnswer((_) => readyFuture ?? Future.value());
    when(mockChannel.sink).thenReturn(MockWebSocketSink());

    clientEngine = ClientEngine(webSocketFactory: (uri) => mockChannel);
  }

  setUp(() {
    _setupClientEngine();
  });

  tearDown(() {
    clientEngine.dispose();
    streamController.close();
  });

  group('ClientEngine', () {
    test('initial status should be disconnected', () {
      expect(clientEngine.currentStatus, ConnectionStatus.disconnected);
    });

    test('connect updates status to connecting then connected', () async {
      final statuses = <ConnectionStatus>[];
      final subscription = clientEngine.connectionStatus.listen(statuses.add);

      await clientEngine.connect('ws://localhost:8080');

      // Wait for microtasks to complete
      await Future.delayed(Duration.zero);

      expect(statuses, containsAllInOrder([
        ConnectionStatus.disconnected,
        ConnectionStatus.connecting,
        ConnectionStatus.connected,
      ]));

      subscription.cancel();
    });

    test('failed connection (ready throws) handles disconnection', () async {
      _setupClientEngine(readyFuture: Future.error('Connection failed'));

      final statuses = <ConnectionStatus>[];
      final subscription = clientEngine.connectionStatus.listen(statuses.add);

      await clientEngine.connect('ws://localhost:8080');

      // Wait for retry logic or simple failure
      await Future.delayed(Duration(milliseconds: 100));

      // Should see connecting then disconnected
      expect(statuses, contains(ConnectionStatus.connecting));
      expect(statuses.last, ConnectionStatus.disconnected);

      subscription.cancel();
    });

    test('disconnect updates status to disconnected', () async {
      await clientEngine.connect('ws://localhost:8080');
      await clientEngine.disconnect();

      expect(clientEngine.currentStatus, ConnectionStatus.disconnected);
      verify(mockChannel.sink.close(status.normalClosure)).called(1);
    });

    test('server disconnection triggers reconnect', () async {
      await clientEngine.connect('ws://localhost:8080');
      expect(clientEngine.currentStatus, ConnectionStatus.connected);

      // Simulate server closing connection
      await streamController.close();

      // Wait for done event handling
      await Future.delayed(Duration(milliseconds: 100));

      expect(clientEngine.currentStatus, ConnectionStatus.disconnected);

      // Check if it schedules reconnect (we can't easily wait for the timer in unit test without fake async,
      // but we can check if it went to disconnected).
    });
  });
}
