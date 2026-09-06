// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'song.dart';

// **************************************************************************
// TypeAdapterGenerator
// **************************************************************************

class LyricLineImplAdapter extends TypeAdapter<_$LyricLineImpl> {
  @override
  final int typeId = 2;

  @override
  _$LyricLineImpl read(BinaryReader reader) {
    final numOfFields = reader.readByte();
    final fields = <int, dynamic>{
      for (int i = 0; i < numOfFields; i++) reader.readByte(): reader.read(),
    };
    return _$LyricLineImpl(
      timeMs: fields[0] as int,
      text: fields[1] as String,
      type: fields[2] as String,
    );
  }

  @override
  void write(BinaryWriter writer, _$LyricLineImpl obj) {
    writer
      ..writeByte(3)
      ..writeByte(0)
      ..write(obj.timeMs)
      ..writeByte(1)
      ..write(obj.text)
      ..writeByte(2)
      ..write(obj.type);
  }

  @override
  int get hashCode => typeId.hashCode;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is LyricLineImplAdapter &&
          runtimeType == other.runtimeType &&
          typeId == other.typeId;
}

class SongImplAdapter extends TypeAdapter<_$SongImpl> {
  @override
  final int typeId = 1;

  @override
  _$SongImpl read(BinaryReader reader) {
    final numOfFields = reader.readByte();
    final fields = <int, dynamic>{
      for (int i = 0; i < numOfFields; i++) reader.readByte(): reader.read(),
    };
    return _$SongImpl(
      id: fields[0] as String,
      title: fields[1] as String,
      artist: fields[6] as String,
      bpm: fields[2] as int,
      signature: fields[3] as String,
      durationMs: fields[4] as int,
      lyrics: (fields[5] as List).cast<LyricLine>(),
    );
  }

  @override
  void write(BinaryWriter writer, _$SongImpl obj) {
    writer
      ..writeByte(7)
      ..writeByte(0)
      ..write(obj.id)
      ..writeByte(1)
      ..write(obj.title)
      ..writeByte(6)
      ..write(obj.artist)
      ..writeByte(2)
      ..write(obj.bpm)
      ..writeByte(3)
      ..write(obj.signature)
      ..writeByte(4)
      ..write(obj.durationMs)
      ..writeByte(5)
      ..write(obj.lyrics);
  }

  @override
  int get hashCode => typeId.hashCode;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is SongImplAdapter &&
          runtimeType == other.runtimeType &&
          typeId == other.typeId;
}

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

_$LyricLineImpl _$$LyricLineImplFromJson(Map<String, dynamic> json) =>
    _$LyricLineImpl(
      timeMs: (json['timeMs'] as num).toInt(),
      text: json['text'] as String,
      type: json['type'] as String? ?? 'verse',
    );

Map<String, dynamic> _$$LyricLineImplToJson(_$LyricLineImpl instance) =>
    <String, dynamic>{
      'timeMs': instance.timeMs,
      'text': instance.text,
      'type': instance.type,
    };

_$SongImpl _$$SongImplFromJson(Map<String, dynamic> json) => _$SongImpl(
      id: json['id'] as String,
      title: json['title'] as String,
      artist: json['artist'] as String? ?? 'Unknown',
      bpm: (json['bpm'] as num?)?.toInt() ?? 120,
      signature: json['signature'] as String? ?? '4/4',
      durationMs: (json['durationMs'] as num?)?.toInt() ?? 0,
      lyrics: (json['lyrics'] as List<dynamic>?)
              ?.map((e) => LyricLine.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const [],
    );

Map<String, dynamic> _$$SongImplToJson(_$SongImpl instance) =>
    <String, dynamic>{
      'id': instance.id,
      'title': instance.title,
      'artist': instance.artist,
      'bpm': instance.bpm,
      'signature': instance.signature,
      'durationMs': instance.durationMs,
      'lyrics': instance.lyrics,
    };
