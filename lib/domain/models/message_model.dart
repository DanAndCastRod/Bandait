enum MessageType {
  handshake,
  ping,
  pong,
  ack,
  syncRequest,
  syncResponse,
  command,
  unknown,
}

class MessageModel {
  final String id;
  final MessageType type;
  final String senderId;
  final int timestamp; // Device timestamp when sent
  final Map<String, dynamic>? payload;

  MessageModel({
    required this.id,
    required this.type,
    required this.senderId,
    required this.timestamp,
    this.payload,
  });

  factory MessageModel.fromJson(Map<String, dynamic> json) {
    return MessageModel(
      id: json['id'] as String,
      type: _messageTypeFromString(json['type'] as String?),
      senderId: json['senderId'] as String,
      timestamp: json['timestamp'] as int,
      payload: json['payload'] as Map<String, dynamic>?,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'type': type.toString().split('.').last.toUpperCase(),
      'senderId': senderId,
      'timestamp': timestamp,
      if (payload != null) 'payload': payload,
    };
  }

  static MessageType _messageTypeFromString(String? type) {
    switch (type) {
      case 'HANDSHAKE':
        return MessageType.handshake;
      case 'PING':
        return MessageType.ping;
      case 'PONG':
        return MessageType.pong;
      case 'ACK':
        return MessageType.ack;
      case 'SYNC_REQUEST':
        return MessageType.syncRequest;
      case 'SYNC_RESPONSE':
        return MessageType.syncResponse;
      case 'COMMAND':
        return MessageType.command;
      default:
        return MessageType.unknown;
    }
  }
}
