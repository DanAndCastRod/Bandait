// lib/data/models/message_model.dart

import '../../domain/entities/message.dart';

class MessageModel extends Message {
  const MessageModel({
    required String id,
    required MessageType type,
    required int timestamp,
    Map<String, dynamic>? payload,
  }) : super(
          id: id,
          type: type,
          timestamp: timestamp,
          payload: payload,
        );

  factory MessageModel.fromJson(Map<String, dynamic> json) {
    if (json['id'] == null) {
      throw FormatException('Missing required field: id');
    }
    if (json['type'] == null) {
      throw FormatException('Missing required field: type');
    }
    if (json['timestamp'] == null) {
      throw FormatException('Missing required field: timestamp');
    }

    return MessageModel(
      id: json['id'] as String,
      type: MessageType.values.firstWhere(
        (e) => e.toString().split('.').last.toUpperCase() == json['type'],
        orElse: () => throw FormatException('Unknown message type: ${json['type']}'),
      ),
      payload: json['payload'] as Map<String, dynamic>?,
      timestamp: json['timestamp'] as int,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'type': type.toString().split('.').last.toUpperCase(),
      'timestamp': timestamp,
      if (payload != null) 'payload': payload,
    };
  }

  factory MessageModel.fromEntity(Message message) {
    return MessageModel(
      id: message.id,
      type: message.type,
      timestamp: message.timestamp,
      payload: message.payload,
    );
  }
}
