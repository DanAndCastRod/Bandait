import 'package:bandait/domain/enums/connection_status.dart';

abstract class ClientEngine {
  /// Connects to the WebSocket server at the given [ip] and [port].
  Future<void> connect(String ip, int port);

  /// Disconnects from the server.
  Future<void> disconnect();

  /// Sends a message to the server.
  void send(Map<String, dynamic> data);

  /// Stream of incoming messages.
  Stream<dynamic> get onMessage;

  /// Stream of connection status changes.
  Stream<ConnectionStatus> get onStatusChanged;

  /// Current status
  ConnectionStatus get currentStatus;
}
