// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'song.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

T _$identity<T>(T value) => value;

final _privateConstructorUsedError = UnsupportedError(
    'It seems like you constructed your class using `MyClass._()`. This constructor is only meant to be used by freezed and you are not supposed to need it nor use it.\nPlease check the documentation here for more information: https://github.com/rrousselGit/freezed#adding-getters-and-methods-to-our-models');

LyricLine _$LyricLineFromJson(Map<String, dynamic> json) {
  return _LyricLine.fromJson(json);
}

/// @nodoc
mixin _$LyricLine {
  @HiveField(0)
  int get timeMs => throw _privateConstructorUsedError;
  @HiveField(1)
  String get text => throw _privateConstructorUsedError;
  @HiveField(2)
  String get type => throw _privateConstructorUsedError;

  Map<String, dynamic> toJson() => throw _privateConstructorUsedError;
  @JsonKey(ignore: true)
  $LyricLineCopyWith<LyricLine> get copyWith =>
      throw _privateConstructorUsedError;
}

/// @nodoc
abstract class $LyricLineCopyWith<$Res> {
  factory $LyricLineCopyWith(LyricLine value, $Res Function(LyricLine) then) =
      _$LyricLineCopyWithImpl<$Res, LyricLine>;
  @useResult
  $Res call(
      {@HiveField(0) int timeMs,
      @HiveField(1) String text,
      @HiveField(2) String type});
}

/// @nodoc
class _$LyricLineCopyWithImpl<$Res, $Val extends LyricLine>
    implements $LyricLineCopyWith<$Res> {
  _$LyricLineCopyWithImpl(this._value, this._then);

  // ignore: unused_field
  final $Val _value;
  // ignore: unused_field
  final $Res Function($Val) _then;

  @pragma('vm:prefer-inline')
  @override
  $Res call({
    Object? timeMs = null,
    Object? text = null,
    Object? type = null,
  }) {
    return _then(_value.copyWith(
      timeMs: null == timeMs
          ? _value.timeMs
          : timeMs // ignore: cast_nullable_to_non_nullable
              as int,
      text: null == text
          ? _value.text
          : text // ignore: cast_nullable_to_non_nullable
              as String,
      type: null == type
          ? _value.type
          : type // ignore: cast_nullable_to_non_nullable
              as String,
    ) as $Val);
  }
}

/// @nodoc
abstract class _$$LyricLineImplCopyWith<$Res>
    implements $LyricLineCopyWith<$Res> {
  factory _$$LyricLineImplCopyWith(
          _$LyricLineImpl value, $Res Function(_$LyricLineImpl) then) =
      __$$LyricLineImplCopyWithImpl<$Res>;
  @override
  @useResult
  $Res call(
      {@HiveField(0) int timeMs,
      @HiveField(1) String text,
      @HiveField(2) String type});
}

/// @nodoc
class __$$LyricLineImplCopyWithImpl<$Res>
    extends _$LyricLineCopyWithImpl<$Res, _$LyricLineImpl>
    implements _$$LyricLineImplCopyWith<$Res> {
  __$$LyricLineImplCopyWithImpl(
      _$LyricLineImpl _value, $Res Function(_$LyricLineImpl) _then)
      : super(_value, _then);

  @pragma('vm:prefer-inline')
  @override
  $Res call({
    Object? timeMs = null,
    Object? text = null,
    Object? type = null,
  }) {
    return _then(_$LyricLineImpl(
      timeMs: null == timeMs
          ? _value.timeMs
          : timeMs // ignore: cast_nullable_to_non_nullable
              as int,
      text: null == text
          ? _value.text
          : text // ignore: cast_nullable_to_non_nullable
              as String,
      type: null == type
          ? _value.type
          : type // ignore: cast_nullable_to_non_nullable
              as String,
    ));
  }
}

/// @nodoc
@JsonSerializable()
@HiveType(typeId: 2)
class _$LyricLineImpl implements _LyricLine {
  const _$LyricLineImpl(
      {@HiveField(0) required this.timeMs,
      @HiveField(1) required this.text,
      @HiveField(2) this.type = 'verse'});

  factory _$LyricLineImpl.fromJson(Map<String, dynamic> json) =>
      _$$LyricLineImplFromJson(json);

  @override
  @HiveField(0)
  final int timeMs;
  @override
  @HiveField(1)
  final String text;
  @override
  @JsonKey()
  @HiveField(2)
  final String type;

  @override
  String toString() {
    return 'LyricLine(timeMs: $timeMs, text: $text, type: $type)';
  }

  @override
  bool operator ==(Object other) {
    return identical(this, other) ||
        (other.runtimeType == runtimeType &&
            other is _$LyricLineImpl &&
            (identical(other.timeMs, timeMs) || other.timeMs == timeMs) &&
            (identical(other.text, text) || other.text == text) &&
            (identical(other.type, type) || other.type == type));
  }

  @JsonKey(ignore: true)
  @override
  int get hashCode => Object.hash(runtimeType, timeMs, text, type);

  @JsonKey(ignore: true)
  @override
  @pragma('vm:prefer-inline')
  _$$LyricLineImplCopyWith<_$LyricLineImpl> get copyWith =>
      __$$LyricLineImplCopyWithImpl<_$LyricLineImpl>(this, _$identity);

  @override
  Map<String, dynamic> toJson() {
    return _$$LyricLineImplToJson(
      this,
    );
  }
}

abstract class _LyricLine implements LyricLine {
  const factory _LyricLine(
      {@HiveField(0) required final int timeMs,
      @HiveField(1) required final String text,
      @HiveField(2) final String type}) = _$LyricLineImpl;

  factory _LyricLine.fromJson(Map<String, dynamic> json) =
      _$LyricLineImpl.fromJson;

  @override
  @HiveField(0)
  int get timeMs;
  @override
  @HiveField(1)
  String get text;
  @override
  @HiveField(2)
  String get type;
  @override
  @JsonKey(ignore: true)
  _$$LyricLineImplCopyWith<_$LyricLineImpl> get copyWith =>
      throw _privateConstructorUsedError;
}

Song _$SongFromJson(Map<String, dynamic> json) {
  return _Song.fromJson(json);
}

/// @nodoc
mixin _$Song {
  @HiveField(0)
  String get id => throw _privateConstructorUsedError;
  @HiveField(1)
  String get title => throw _privateConstructorUsedError;
  @HiveField(6)
  String get artist => throw _privateConstructorUsedError; // New Field
  @HiveField(2)
  int get bpm => throw _privateConstructorUsedError;
  @HiveField(3)
  String get signature => throw _privateConstructorUsedError;
  @HiveField(4)
  int get durationMs => throw _privateConstructorUsedError;
  @HiveField(5)
  List<LyricLine> get lyrics => throw _privateConstructorUsedError;

  Map<String, dynamic> toJson() => throw _privateConstructorUsedError;
  @JsonKey(ignore: true)
  $SongCopyWith<Song> get copyWith => throw _privateConstructorUsedError;
}

/// @nodoc
abstract class $SongCopyWith<$Res> {
  factory $SongCopyWith(Song value, $Res Function(Song) then) =
      _$SongCopyWithImpl<$Res, Song>;
  @useResult
  $Res call(
      {@HiveField(0) String id,
      @HiveField(1) String title,
      @HiveField(6) String artist,
      @HiveField(2) int bpm,
      @HiveField(3) String signature,
      @HiveField(4) int durationMs,
      @HiveField(5) List<LyricLine> lyrics});
}

/// @nodoc
class _$SongCopyWithImpl<$Res, $Val extends Song>
    implements $SongCopyWith<$Res> {
  _$SongCopyWithImpl(this._value, this._then);

  // ignore: unused_field
  final $Val _value;
  // ignore: unused_field
  final $Res Function($Val) _then;

  @pragma('vm:prefer-inline')
  @override
  $Res call({
    Object? id = null,
    Object? title = null,
    Object? artist = null,
    Object? bpm = null,
    Object? signature = null,
    Object? durationMs = null,
    Object? lyrics = null,
  }) {
    return _then(_value.copyWith(
      id: null == id
          ? _value.id
          : id // ignore: cast_nullable_to_non_nullable
              as String,
      title: null == title
          ? _value.title
          : title // ignore: cast_nullable_to_non_nullable
              as String,
      artist: null == artist
          ? _value.artist
          : artist // ignore: cast_nullable_to_non_nullable
              as String,
      bpm: null == bpm
          ? _value.bpm
          : bpm // ignore: cast_nullable_to_non_nullable
              as int,
      signature: null == signature
          ? _value.signature
          : signature // ignore: cast_nullable_to_non_nullable
              as String,
      durationMs: null == durationMs
          ? _value.durationMs
          : durationMs // ignore: cast_nullable_to_non_nullable
              as int,
      lyrics: null == lyrics
          ? _value.lyrics
          : lyrics // ignore: cast_nullable_to_non_nullable
              as List<LyricLine>,
    ) as $Val);
  }
}

/// @nodoc
abstract class _$$SongImplCopyWith<$Res> implements $SongCopyWith<$Res> {
  factory _$$SongImplCopyWith(
          _$SongImpl value, $Res Function(_$SongImpl) then) =
      __$$SongImplCopyWithImpl<$Res>;
  @override
  @useResult
  $Res call(
      {@HiveField(0) String id,
      @HiveField(1) String title,
      @HiveField(6) String artist,
      @HiveField(2) int bpm,
      @HiveField(3) String signature,
      @HiveField(4) int durationMs,
      @HiveField(5) List<LyricLine> lyrics});
}

/// @nodoc
class __$$SongImplCopyWithImpl<$Res>
    extends _$SongCopyWithImpl<$Res, _$SongImpl>
    implements _$$SongImplCopyWith<$Res> {
  __$$SongImplCopyWithImpl(_$SongImpl _value, $Res Function(_$SongImpl) _then)
      : super(_value, _then);

  @pragma('vm:prefer-inline')
  @override
  $Res call({
    Object? id = null,
    Object? title = null,
    Object? artist = null,
    Object? bpm = null,
    Object? signature = null,
    Object? durationMs = null,
    Object? lyrics = null,
  }) {
    return _then(_$SongImpl(
      id: null == id
          ? _value.id
          : id // ignore: cast_nullable_to_non_nullable
              as String,
      title: null == title
          ? _value.title
          : title // ignore: cast_nullable_to_non_nullable
              as String,
      artist: null == artist
          ? _value.artist
          : artist // ignore: cast_nullable_to_non_nullable
              as String,
      bpm: null == bpm
          ? _value.bpm
          : bpm // ignore: cast_nullable_to_non_nullable
              as int,
      signature: null == signature
          ? _value.signature
          : signature // ignore: cast_nullable_to_non_nullable
              as String,
      durationMs: null == durationMs
          ? _value.durationMs
          : durationMs // ignore: cast_nullable_to_non_nullable
              as int,
      lyrics: null == lyrics
          ? _value._lyrics
          : lyrics // ignore: cast_nullable_to_non_nullable
              as List<LyricLine>,
    ));
  }
}

/// @nodoc
@JsonSerializable()
@HiveType(typeId: 1)
class _$SongImpl implements _Song {
  const _$SongImpl(
      {@HiveField(0) required this.id,
      @HiveField(1) required this.title,
      @HiveField(6) this.artist = 'Unknown',
      @HiveField(2) this.bpm = 120,
      @HiveField(3) this.signature = '4/4',
      @HiveField(4) this.durationMs = 0,
      @HiveField(5) final List<LyricLine> lyrics = const []})
      : _lyrics = lyrics;

  factory _$SongImpl.fromJson(Map<String, dynamic> json) =>
      _$$SongImplFromJson(json);

  @override
  @HiveField(0)
  final String id;
  @override
  @HiveField(1)
  final String title;
  @override
  @JsonKey()
  @HiveField(6)
  final String artist;
// New Field
  @override
  @JsonKey()
  @HiveField(2)
  final int bpm;
  @override
  @JsonKey()
  @HiveField(3)
  final String signature;
  @override
  @JsonKey()
  @HiveField(4)
  final int durationMs;
  final List<LyricLine> _lyrics;
  @override
  @JsonKey()
  @HiveField(5)
  List<LyricLine> get lyrics {
    if (_lyrics is EqualUnmodifiableListView) return _lyrics;
    // ignore: implicit_dynamic_type
    return EqualUnmodifiableListView(_lyrics);
  }

  @override
  String toString() {
    return 'Song(id: $id, title: $title, artist: $artist, bpm: $bpm, signature: $signature, durationMs: $durationMs, lyrics: $lyrics)';
  }

  @override
  bool operator ==(Object other) {
    return identical(this, other) ||
        (other.runtimeType == runtimeType &&
            other is _$SongImpl &&
            (identical(other.id, id) || other.id == id) &&
            (identical(other.title, title) || other.title == title) &&
            (identical(other.artist, artist) || other.artist == artist) &&
            (identical(other.bpm, bpm) || other.bpm == bpm) &&
            (identical(other.signature, signature) ||
                other.signature == signature) &&
            (identical(other.durationMs, durationMs) ||
                other.durationMs == durationMs) &&
            const DeepCollectionEquality().equals(other._lyrics, _lyrics));
  }

  @JsonKey(ignore: true)
  @override
  int get hashCode => Object.hash(runtimeType, id, title, artist, bpm,
      signature, durationMs, const DeepCollectionEquality().hash(_lyrics));

  @JsonKey(ignore: true)
  @override
  @pragma('vm:prefer-inline')
  _$$SongImplCopyWith<_$SongImpl> get copyWith =>
      __$$SongImplCopyWithImpl<_$SongImpl>(this, _$identity);

  @override
  Map<String, dynamic> toJson() {
    return _$$SongImplToJson(
      this,
    );
  }
}

abstract class _Song implements Song {
  const factory _Song(
      {@HiveField(0) required final String id,
      @HiveField(1) required final String title,
      @HiveField(6) final String artist,
      @HiveField(2) final int bpm,
      @HiveField(3) final String signature,
      @HiveField(4) final int durationMs,
      @HiveField(5) final List<LyricLine> lyrics}) = _$SongImpl;

  factory _Song.fromJson(Map<String, dynamic> json) = _$SongImpl.fromJson;

  @override
  @HiveField(0)
  String get id;
  @override
  @HiveField(1)
  String get title;
  @override
  @HiveField(6)
  String get artist;
  @override // New Field
  @HiveField(2)
  int get bpm;
  @override
  @HiveField(3)
  String get signature;
  @override
  @HiveField(4)
  int get durationMs;
  @override
  @HiveField(5)
  List<LyricLine> get lyrics;
  @override
  @JsonKey(ignore: true)
  _$$SongImplCopyWith<_$SongImpl> get copyWith =>
      throw _privateConstructorUsedError;
}
