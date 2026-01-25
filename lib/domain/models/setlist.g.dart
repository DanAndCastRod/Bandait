// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'setlist.dart';

// **************************************************************************
// TypeAdapterGenerator
// **************************************************************************

class SetlistImplAdapter extends TypeAdapter<_$SetlistImpl> {
  @override
  final int typeId = 3;

  @override
  _$SetlistImpl read(BinaryReader reader) {
    final numOfFields = reader.readByte();
    final fields = <int, dynamic>{
      for (int i = 0; i < numOfFields; i++) reader.readByte(): reader.read(),
    };
    return _$SetlistImpl(
      id: fields[0] as String,
      title: fields[1] as String,
      createdDate: fields[2] as DateTime,
      songIds: (fields[3] as List).cast<String>(),
    );
  }

  @override
  void write(BinaryWriter writer, _$SetlistImpl obj) {
    writer
      ..writeByte(4)
      ..writeByte(0)
      ..write(obj.id)
      ..writeByte(1)
      ..write(obj.title)
      ..writeByte(2)
      ..write(obj.createdDate)
      ..writeByte(3)
      ..write(obj.songIds);
  }

  @override
  int get hashCode => typeId.hashCode;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is SetlistImplAdapter &&
          runtimeType == other.runtimeType &&
          typeId == other.typeId;
}
