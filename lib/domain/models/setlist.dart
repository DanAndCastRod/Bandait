import 'package:freezed_annotation/freezed_annotation.dart';
import 'package:hive/hive.dart';

part 'setlist.freezed.dart';
part 'setlist.g.dart';

@freezed
class Setlist with _$Setlist {
  @HiveType(typeId: 3) // TypeId 1 = Song, TypeId 2 = LyricLine
  const factory Setlist({
    @HiveField(0) required String id,
    @HiveField(1) required String title,
    @HiveField(2) required DateTime createdDate,
    @HiveField(3) @Default([]) List<String> songIds, // References to Song.id
  }) = _Setlist;
}
