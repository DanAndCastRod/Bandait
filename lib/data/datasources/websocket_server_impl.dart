import 'dart:async';
import 'dart:convert';
import 'dart:developer';
import 'dart:io';

import 'package:injectable/injectable.dart';
import '../../core/message_handler.dart';
import '../../domain/entities/client_connection.dart';
import '../../domain/enums/message_type.dart';
import '../../domain/repositories/server_engine.dart';

@Singleton(as: ServerEngine)
class WebSocketServerImpl implements ServerEngine {
  HttpServer? _server;
  final Map<String, WebSocket> _clientSockets = {};
  final _clientConnectedController =
      StreamController<ClientConnection>.broadcast();
  final _clientDisconnectedController =
      StreamController<ClientConnection>.broadcast();

  final MessageHandler _messageHandler = MessageHandler();

  // Simple ID generator
  int _idCounter = 0;

  @override
  Stream<ClientConnection> get onClientConnected =>
      _clientConnectedController.stream;

  @override
  Stream<ClientConnection> get onClientDisconnected =>
      _clientDisconnectedController.stream;

  @override
  Future<void> start({int port = 4040}) async {
    await stop(); // Ensure previous instance is closed
    try {
      _server = await HttpServer.bind(InternetAddress.anyIPv4, port);
      log(
        'WebSocket Server running on ws://${_server?.address.address}:${_server?.port}',
        name: 'WebSocketServerImpl',
      );

      _server!.listen((HttpRequest req) async {
        if (WebSocketTransformer.isUpgradeRequest(req)) {
          final socket = await WebSocketTransformer.upgrade(req);
          // Add a done handler to clean up socket on disconnect
          socket.done.then((_) {
            _clientSockets.removeWhere((key, value) => value == socket);
          });
          _handleConnection(socket);
        }
      });
    } catch (e) {
      log('Error starting server: $e', name: 'WebSocketServerImpl', error: e);
      // Don't rethrow if it's "Address already in use" to prevent crash?
      // No, UI should know.
      rethrow;
    }
  }

  void _handleConnection(WebSocket socket) {
    final clientId = 'client_${++_idCounter}';
    _clientSockets[clientId] = socket;

    final connection = ClientConnection(
      id: clientId,
      connectionTime: DateTime.now(),
      lastPing: DateTime.now(),
    );

    _clientConnectedController.add(connection);
    log('Client connected: $clientId', name: 'WebSocketServerImpl');

    // Send HANDSHAKE response immediately
    _sendToClient(clientId, _messageHandler.createHandshakeResponse(clientId));

    socket.listen(
      (data) {
        final t1 = DateTime.now().millisecondsSinceEpoch; // Server receive time
        _processMessage(clientId, data.toString(), t1);
      },
      onDone: () {
        _clientSockets.remove(clientId);
        _clientDisconnectedController.add(connection);
        log('Client disconnected: $clientId', name: 'WebSocketServerImpl');
      },
      onError: (error) {
        _clientSockets.remove(clientId);
        _clientDisconnectedController.add(connection);
        log(
          'Error from $clientId: $error',
          name: 'WebSocketServerImpl',
          error: error,
        );
      },
    );
  }

  void _processMessage(String clientId, String rawData, int t1) {
    final message = _messageHandler.parse(rawData);
    if (message == null) {
      log('Invalid message from $clientId', name: 'WebSocketServerImpl');
      return;
    }

    log(
      'Processing ${message.type} from $clientId',
      name: 'WebSocketServerImpl',
    );

    switch (message.type) {
      case MessageType.ping:
        _sendToClient(clientId, _messageHandler.createPong(message));
        break;
      case MessageType.syncRequest:
        final t0 = message.payload['t0'] as int? ?? message.timestamp;
        _sendToClient(
          clientId,
          _messageHandler.createSyncResponse(t0: t0, t1: t1),
        );
        break;
      case MessageType.handshake:
      case MessageType.pong:
      case MessageType.ack:
      case MessageType.syncResponse:
      case MessageType.flash:
      case MessageType.startMetronome:
      case MessageType.stopMetronome:
      case MessageType.bpmChange:
        // These are client-side or acknowledgement messages, log only
        log(
          'Received ${message.type} from $clientId',
          name: 'WebSocketServerImpl',
        );
        break;
    }
  }

  void _sendToClient(String clientId, dynamic data) {
    final socket = _clientSockets[clientId];
    if (socket != null && socket.readyState == WebSocket.open) {
      final jsonStr = data is String ? data : jsonEncode(data.toJson());
      socket.add(jsonStr);
    }
  }

  @override
  Future<void> stop() async {
    // Create a copy to avoid ConcurrentModificationError
    // when socket.done handler removes items from the map
    final sockets = _clientSockets.values.toList();
    for (var socket in sockets) {
      await socket.close();
    }
    _clientSockets.clear();
    await _server?.close();
    _server = null;
    log('Server stopped', name: 'WebSocketServerImpl');
  }

  @override
  void broadcast(Map<String, dynamic> data) {
    if (_clientSockets.isEmpty) return;
    final jsonStr = jsonEncode(data);
    for (var socket in _clientSockets.values) {
      if (socket.readyState == WebSocket.open) {
        socket.add(jsonStr);
      }
    }
  }
}
