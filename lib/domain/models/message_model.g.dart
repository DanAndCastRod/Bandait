// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'message_model.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

_$MessageModelImpl _$$MessageModelImplFromJson(Map<String, dynamic> json) =>
    _$MessageModelImpl(
      type: $enumDecode(_$MessageTypeEnumMap, json['type']),
      payload: json['payload'] as Map<String, dynamic>? ?? const {},
      timestamp: (json['timestamp'] as num).toInt(),
      senderId: json['senderId'] as String?,
    );

Map<String, dynamic> _$$MessageModelImplToJson(_$MessageModelImpl instance) =>
    <String, dynamic>{
      'type': _$MessageTypeEnumMap[instance.type]!,
      'payload': instance.payload,
      'timestamp': instance.timestamp,
      'senderId': instance.senderId,
    };

const _$MessageTypeEnumMap = {
  MessageType.handshake: 'handshake',
  MessageType.ping: 'ping',
  MessageType.pong: 'pong',
  MessageType.ack: 'ack',
  MessageType.syncRequest: 'syncRequest',
  MessageType.syncResponse: 'syncResponse',
  MessageType.flash: 'flash',
  MessageType.startMetronome: 'startMetronome',
  MessageType.stopMetronome: 'stopMetronome',
  MessageType.bpmChange: 'bpmChange',
};
