import 'package:freezed_annotation/freezed_annotation.dart';
import 'package:hive/hive.dart';

part 'song.freezed.dart';
part 'song.g.dart';

@freezed
class LyricLine with _$LyricLine {
  @HiveType(typeId: 2)
  const factory LyricLine({
    @HiveField(0) required int timeMs,
    @HiveField(1) required String text,
    @HiveField(2)
    @Default('verse')
    String type, // verse, chorus, section_header
  }) = _LyricLine;

  factory LyricLine.fromJson(Map<String, dynamic> json) =>
      _$LyricLineFromJson(json);
}

@freezed
class Song with _$Song {
  @HiveType(typeId: 1)
  const factory Song({
    @HiveField(0) required String id,
    @HiveField(1) required String title,
    @HiveField(6) @Default('Unknown') String artist, // New Field
    @HiveField(2) @Default(120) int bpm,
    @HiveField(3) @Default('4/4') String signature,
    @HiveField(4) @Default(0) int durationMs,
    @HiveField(5) @Default([]) List<LyricLine> lyrics,
  }) = _Song;

  factory Song.fromJson(Map<String, dynamic> json) => _$SongFromJson(json);
}
