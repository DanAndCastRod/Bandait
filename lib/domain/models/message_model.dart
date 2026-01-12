enum MessageType {
  handshake,
  ping,
  pong,
  ack,
}

class MessageModel {
  final MessageType type;
  final Map<String, dynamic>? payload;
  final String? id;
  final int timestamp;

  MessageModel({
    required this.type,
    this.payload,
    this.id,
    required this.timestamp,
  });

  factory MessageModel.fromJson(Map<String, dynamic> json) {
    return MessageModel(
      type: MessageType.values.firstWhere(
        (e) => e.name.toUpperCase() == (json['type'] as String).toUpperCase(),
        orElse: () => throw FormatException('Unknown message type: ${json['type']}'),
      ),
      payload: json['payload'] as Map<String, dynamic>?,
      id: json['id'] as String?,
      timestamp: json['timestamp'] as int,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'type': type.name.toUpperCase(),
      if (payload != null) 'payload': payload,
      if (id != null) 'id': id,
      'timestamp': timestamp,
    };
  }

  @override
  String toString() {
    return 'MessageModel(type: $type, payload: $payload, id: $id, timestamp: $timestamp)';
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;

    return other is MessageModel &&
      other.type == type &&
      // Simplistic map comparison for this specific task context
      // In a real project with `equatable` or `freezed`, this would be better.
      (other.payload.toString() == payload.toString()) &&
      other.id == id &&
      other.timestamp == timestamp;
  }

  @override
  int get hashCode {
    return type.hashCode ^ payload.hashCode ^ id.hashCode ^ timestamp.hashCode;
  }
}
