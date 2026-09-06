import '../entities/client_connection.dart';

abstract class ServerEngine {
  /// Starts the WebSocket server on the specified port.
  /// If [port] is not provided, it should default to a standard port (e.g. 8080 or 0 for ephemeral).
  Future<void> start({int port = 0});

  /// Stops the server and closes all active connections.
  Future<void> stop();

  /// Broadcasts a message to all connected clients.
  void broadcast(Map<String, dynamic> data);

  /// Stream of new client connections.
  Stream<ClientConnection> get onClientConnected;

  /// Stream of client disconnections.
  Stream<ClientConnection> get onClientDisconnected;
}
