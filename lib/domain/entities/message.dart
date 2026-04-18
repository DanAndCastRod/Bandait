// lib/domain/entities/message.dart

enum MessageType {
  handshake,
  ping,
  pong,
  ack,
}

class Message {
  final String id;
  final MessageType type;
  final Map<String, dynamic>? payload;
  final int timestamp;

  const Message({
    required this.id,
    required this.type,
    required this.timestamp,
    this.payload,
  });

  @override
  String toString() {
    return 'Message(id: $id, type: $type, timestamp: $timestamp, payload: $payload)';
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;

    return other is Message &&
        other.id == id &&
        other.type == type &&
        other.timestamp == timestamp &&
        _mapEquals(other.payload, payload);
  }

  @override
  int get hashCode {
    return id.hashCode ^ type.hashCode ^ timestamp.hashCode ^ payload.hashCode;
  }

  bool _mapEquals(Map<String, dynamic>? a, Map<String, dynamic>? b) {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    if (a.length != b.length) return false;

    for (final key in a.keys) {
      if (!b.containsKey(key) || b[key] != a[key]) {
        return false;
      }
    }
    return true;
  }
}
