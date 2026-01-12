import 'dart:async';
import 'dart:io';

import 'package:logging/logging.dart';
import 'package:shelf/shelf_io.dart' as shelf_io;
import 'package:shelf_web_socket/shelf_web_socket.dart';
import 'package:uuid/uuid.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../../domain/entities/client_session.dart';

/// Service responsible for managing the WebSocket server and connected clients.
class ServerEngine {
  final Logger _logger = Logger('ServerEngine');
  final Uuid _uuid = Uuid();

  /// Registry of connected clients mapped by their ID.
  final Map<String, ClientSession> _clients = {};

  HttpServer? _server;

  /// Returns a list of currently connected clients.
  List<ClientSession> get connectedClients => List.unmodifiable(_clients.values);

  /// Starts the WebSocket server on the specified [address] and [port].
  Future<void> start(dynamic address, int port) async {
    var handler = webSocketHandler((WebSocketChannel webSocket) {
      _handleConnection(webSocket);
    });

    try {
      _server = await shelf_io.serve(handler, address, port);
      _logger.info('Serving at ws://${_server!.address.host}:${_server!.port}');
    } catch (e) {
      _logger.severe('Failed to start server: $e');
      rethrow;
    }
  }

  /// Stops the server and closes all client connections.
  Future<void> stop() async {
    _logger.info('Stopping server...');
    for (var client in _clients.values) {
      await client.channel.sink.close();
    }
    _clients.clear();
    await _server?.close(force: true);
    _logger.info('Server stopped.');
  }

  /// Handles a new WebSocket connection.
  void _handleConnection(WebSocketChannel webSocket) {
    final clientId = _uuid.v4();
    final session = ClientSession(
      id: clientId,
      channel: webSocket,
      connectedAt: DateTime.now(),
    );

    _addClient(session);

    webSocket.stream.listen(
      (message) {
        _logger.info('Received message from $clientId: $message');
        // TODO: Handle message processing
      },
      onError: (error) {
        _logger.warning('Error on connection $clientId: $error');
        _removeClient(clientId);
      },
      onDone: () {
        _logger.info('Connection closed for $clientId');
        _removeClient(clientId);
      },
    );
  }

  /// Adds a client to the registry.
  void _addClient(ClientSession session) {
    _clients[session.id] = session;
    _logger.info('Client connected: ${session.id}. Total clients: ${_clients.length}');
  }

  /// Removes a client from the registry.
  void _removeClient(String clientId) {
    if (_clients.containsKey(clientId)) {
      _clients.remove(clientId);
      _logger.info('Client disconnected: $clientId. Total clients: ${_clients.length}');
    }
  }

  /// Broadcasts a message to all connected clients.
  void broadcast(dynamic message) {
    _logger.info('Broadcasting message to ${_clients.length} clients');
    for (var client in _clients.values) {
      try {
        client.channel.sink.add(message);
      } catch (e) {
        _logger.warning('Failed to send message to ${client.id}: $e');
      }
    }
  }
}
