import 'dart:async';
import 'dart:convert';

import 'package:bandait/data/services/server_engine_impl.dart';
import 'package:bandait/domain/models/message_model.dart';
import 'package:test/test.dart';
import 'package:web_socket_channel/io.dart';

void main() {
  group('ServerEngineImpl', () {
    late ServerEngineImpl server;
    const int port = 8080;

    setUp(() async {
      server = ServerEngineImpl();
      await server.start(port);
    });

    tearDown(() async {
      await server.stop();
    });

    test('accepts connection and handles handshake', () async {
      final channel = IOWebSocketChannel.connect(Uri.parse('ws://localhost:$port'));

      final handshakeMsg = MessageModel(
        id: '1',
        type: MessageType.handshake,
        senderId: 'client_1',
        timestamp: DateTime.now().millisecondsSinceEpoch,
      );

      channel.sink.add(jsonEncode(handshakeMsg.toJson()));

      // Wait for server to process
      await Future.delayed(Duration(milliseconds: 100));

      expect(server.connectedClients, contains('client_1'));

      await channel.sink.close();
    });

    test('broadcasts messages to connected clients', () async {
       final channel1 = IOWebSocketChannel.connect(Uri.parse('ws://localhost:$port'));
       final channel2 = IOWebSocketChannel.connect(Uri.parse('ws://localhost:$port'));

       // Setup listeners to capture messages
       final completer1 = Completer<String>();
       final completer2 = Completer<String>();

       // We need to look for the COMMAND message, ignoring ACKs
       channel1.stream.listen((event) {
          final msg = jsonDecode(event.toString());
          if (msg['type'] == 'COMMAND') {
             if (!completer1.isCompleted) completer1.complete(event.toString());
          }
       });

       channel2.stream.listen((event) {
          final msg = jsonDecode(event.toString());
          if (msg['type'] == 'COMMAND') {
             if (!completer2.isCompleted) completer2.complete(event.toString());
          }
       });

       // Handshake 1
       channel1.sink.add(jsonEncode(MessageModel(
        id: '1', type: MessageType.handshake, senderId: 'c1', timestamp: 0).toJson()));

       // Handshake 2
       channel2.sink.add(jsonEncode(MessageModel(
        id: '2', type: MessageType.handshake, senderId: 'c2', timestamp: 0).toJson()));

       await Future.delayed(Duration(milliseconds: 100));

       // Server Broadcast
       final broadcastMsg = MessageModel(
         id: '3', type: MessageType.command, senderId: 'SERVER', timestamp: 0,
         payload: {'cmd': 'START'}
       );
       server.broadcast(broadcastMsg);

       final msg1 = await completer1.future.timeout(Duration(seconds: 2));
       final msg2 = await completer2.future.timeout(Duration(seconds: 2));

       expect(msg1, contains('START'));
       expect(msg2, contains('START'));

       await channel1.sink.close();
       await channel2.sink.close();
    });
  });
}
