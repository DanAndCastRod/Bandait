// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'sync_result.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

_$SyncResultImpl _$$SyncResultImplFromJson(Map<String, dynamic> json) =>
    _$SyncResultImpl(
      offsetMs: (json['offsetMs'] as num).toInt(),
      rttMs: (json['rttMs'] as num).toInt(),
      timestamp: (json['timestamp'] as num).toInt(),
      isValid: json['isValid'] as bool? ?? true,
    );

Map<String, dynamic> _$$SyncResultImplToJson(_$SyncResultImpl instance) =>
    <String, dynamic>{
      'offsetMs': instance.offsetMs,
      'rttMs': instance.rttMs,
      'timestamp': instance.timestamp,
      'isValid': instance.isValid,
    };
