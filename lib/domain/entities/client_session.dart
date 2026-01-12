import 'package:web_socket_channel/web_socket_channel.dart';

/// Represents a connected client in the system.
class ClientSession {
  /// Unique identifier for the client.
  final String id;

  /// The WebSocket channel associated with the client.
  final WebSocketChannel channel;

  /// The time when the client connected.
  final DateTime connectedAt;

  ClientSession({
    required this.id,
    required this.channel,
    required this.connectedAt,
  });

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;

    return other is ClientSession &&
      other.id == id;
  }

  @override
  int get hashCode => id.hashCode;

  @override
  String toString() => 'ClientSession(id: $id, connectedAt: $connectedAt)';
}
