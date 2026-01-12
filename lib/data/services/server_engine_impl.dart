import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:bandait/domain/models/message_model.dart';
import 'package:bandait/domain/services/server_engine.dart';
import 'package:shelf/shelf.dart';
import 'package:shelf/shelf_io.dart' as shelf_io;
import 'package:shelf_web_socket/shelf_web_socket.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:injectable/injectable.dart';

@Singleton(as: ServerEngine)
class ServerEngineImpl implements ServerEngine {
  HttpServer? _server;
  final Map<String, WebSocketChannel> _clients = {};

  final _messageController = StreamController<MessageModel>.broadcast();
  final _connectionController = StreamController<String>.broadcast();
  final _disconnectionController = StreamController<String>.broadcast();

  @override
  Stream<MessageModel> get messageStream => _messageController.stream;

  @override
  Stream<String> get clientConnectionStream => _connectionController.stream;

  @override
  Stream<String> get clientDisconnectionStream => _disconnectionController.stream;

  @override
  List<String> get connectedClients => _clients.keys.toList();

  @override
  Future<void> start(int port) async {
    var handler = webSocketHandler((WebSocketChannel webSocket) {
      // Temporary ID until HANDSHAKE is received, or we can assign one here.
      // For now, let's wait for the client to send a HANDSHAKE message to register.
      // Or we can assume the client ID is the responsibility of the Server to assign if not provided.
      // But typically, the device might have a persistent ID.
      // Let's implement a temporary session handling.

      String? clientId;

      webSocket.stream.listen(
        (message) {
          try {
            final parsedMessage = MessageModel.fromJson(jsonDecode(message as String));

            if (parsedMessage.type == MessageType.handshake) {
              clientId = parsedMessage.senderId;
              _clients[clientId!] = webSocket;
              _connectionController.add(clientId!);
              print('Client connected: $clientId');

              // Send ACK
               final ack = MessageModel(
                id: 'ack_${DateTime.now().millisecondsSinceEpoch}',
                type: MessageType.ack,
                senderId: 'SERVER',
                timestamp: DateTime.now().millisecondsSinceEpoch,
                payload: {'received_id': parsedMessage.id},
              );
              webSocket.sink.add(jsonEncode(ack.toJson()));
            }

            if (clientId != null) {
               _messageController.add(parsedMessage);
            } else {
               // Ignore messages from unauthenticated clients, except handshake
               // Or maybe assign a temporary ID?
               print('Received message from unauthenticated client');
            }

          } catch (e) {
            print('Error parsing message: $e');
          }
        },
        onDone: () {
          if (clientId != null && _clients[clientId] == webSocket) {
            _clients.remove(clientId);
            _disconnectionController.add(clientId!);
            print('Client disconnected: $clientId');
          }
        },
        onError: (error) {
           print('WebSocket error: $error');
           if (clientId != null && _clients[clientId] == webSocket) {
            _clients.remove(clientId);
            _disconnectionController.add(clientId!);
          }
        }
      );
    });

    _server = await shelf_io.serve(handler, InternetAddress.anyIPv4, port);
    print('WebSocket Server listening on port ${_server!.port}');
  }

  @override
  Future<void> stop() async {
    await _server?.close(force: true);
    for (var client in _clients.values.toList()) {
      await client.sink.close();
    }
    _clients.clear();
    _server = null;
    print('Server stopped');
  }

  @override
  void broadcast(MessageModel message) {
    final encodedMessage = jsonEncode(message.toJson());
    for (var client in _clients.values) {
      try {
        client.sink.add(encodedMessage);
      } catch (e) {
        print('Error broadcasting to client: $e');
      }
    }
  }

  @override
  void sendToClient(String clientId, MessageModel message) {
    final client = _clients[clientId];
    if (client != null) {
      try {
        client.sink.add(jsonEncode(message.toJson()));
      } catch (e) {
         print('Error sending to client $clientId: $e');
      }
    } else {
      print('Client $clientId not found');
    }
  }

  // Dispose controllers if necessary, usually Singleton lives forever or has a dispose method
  void dispose() {
    _messageController.close();
    _connectionController.close();
    _disconnectionController.close();
  }
}
