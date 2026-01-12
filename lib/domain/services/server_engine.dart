import 'package:bandait/domain/models/message_model.dart';

abstract class ServerEngine {
  /// Starts the WebSocket server on the specified [port].
  Future<void> start(int port);

  /// Stops the server and closes all connections.
  Future<void> stop();

  /// Broadcasts a [message] to all connected clients.
  void broadcast(MessageModel message);

  /// Sends a [message] to a specific client identified by [clientId].
  void sendToClient(String clientId, MessageModel message);

  /// Stream of received messages from clients.
  Stream<MessageModel> get messageStream;

  /// Stream of connection events (client connected/disconnected).
  /// Returns the clientId.
  Stream<String> get clientConnectionStream;

  /// Stream of disconnection events.
  /// Returns the clientId.
  Stream<String> get clientDisconnectionStream;

  /// Returns the list of currently connected client IDs.
  List<String> get connectedClients;
}
