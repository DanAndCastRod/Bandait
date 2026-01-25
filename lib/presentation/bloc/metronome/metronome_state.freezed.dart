// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'metronome_state.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

T _$identity<T>(T value) => value;

final _privateConstructorUsedError = UnsupportedError(
    'It seems like you constructed your class using `MyClass._()`. This constructor is only meant to be used by freezed and you are not supposed to need it nor use it.\nPlease check the documentation here for more information: https://github.com/rrousselGit/freezed#adding-getters-and-methods-to-our-models');

/// @nodoc
mixin _$MetronomeState {
  bool get isPlaying => throw _privateConstructorUsedError;
  int get bpm => throw _privateConstructorUsedError;
  int get currentBeat => throw _privateConstructorUsedError;

  @JsonKey(ignore: true)
  $MetronomeStateCopyWith<MetronomeState> get copyWith =>
      throw _privateConstructorUsedError;
}

/// @nodoc
abstract class $MetronomeStateCopyWith<$Res> {
  factory $MetronomeStateCopyWith(
          MetronomeState value, $Res Function(MetronomeState) then) =
      _$MetronomeStateCopyWithImpl<$Res, MetronomeState>;
  @useResult
  $Res call({bool isPlaying, int bpm, int currentBeat});
}

/// @nodoc
class _$MetronomeStateCopyWithImpl<$Res, $Val extends MetronomeState>
    implements $MetronomeStateCopyWith<$Res> {
  _$MetronomeStateCopyWithImpl(this._value, this._then);

  // ignore: unused_field
  final $Val _value;
  // ignore: unused_field
  final $Res Function($Val) _then;

  @pragma('vm:prefer-inline')
  @override
  $Res call({
    Object? isPlaying = null,
    Object? bpm = null,
    Object? currentBeat = null,
  }) {
    return _then(_value.copyWith(
      isPlaying: null == isPlaying
          ? _value.isPlaying
          : isPlaying // ignore: cast_nullable_to_non_nullable
              as bool,
      bpm: null == bpm
          ? _value.bpm
          : bpm // ignore: cast_nullable_to_non_nullable
              as int,
      currentBeat: null == currentBeat
          ? _value.currentBeat
          : currentBeat // ignore: cast_nullable_to_non_nullable
              as int,
    ) as $Val);
  }
}

/// @nodoc
abstract class _$$MetronomeStateImplCopyWith<$Res>
    implements $MetronomeStateCopyWith<$Res> {
  factory _$$MetronomeStateImplCopyWith(_$MetronomeStateImpl value,
          $Res Function(_$MetronomeStateImpl) then) =
      __$$MetronomeStateImplCopyWithImpl<$Res>;
  @override
  @useResult
  $Res call({bool isPlaying, int bpm, int currentBeat});
}

/// @nodoc
class __$$MetronomeStateImplCopyWithImpl<$Res>
    extends _$MetronomeStateCopyWithImpl<$Res, _$MetronomeStateImpl>
    implements _$$MetronomeStateImplCopyWith<$Res> {
  __$$MetronomeStateImplCopyWithImpl(
      _$MetronomeStateImpl _value, $Res Function(_$MetronomeStateImpl) _then)
      : super(_value, _then);

  @pragma('vm:prefer-inline')
  @override
  $Res call({
    Object? isPlaying = null,
    Object? bpm = null,
    Object? currentBeat = null,
  }) {
    return _then(_$MetronomeStateImpl(
      isPlaying: null == isPlaying
          ? _value.isPlaying
          : isPlaying // ignore: cast_nullable_to_non_nullable
              as bool,
      bpm: null == bpm
          ? _value.bpm
          : bpm // ignore: cast_nullable_to_non_nullable
              as int,
      currentBeat: null == currentBeat
          ? _value.currentBeat
          : currentBeat // ignore: cast_nullable_to_non_nullable
              as int,
    ));
  }
}

/// @nodoc

class _$MetronomeStateImpl implements _MetronomeState {
  const _$MetronomeStateImpl(
      {this.isPlaying = false, this.bpm = 120, this.currentBeat = 1});

  @override
  @JsonKey()
  final bool isPlaying;
  @override
  @JsonKey()
  final int bpm;
  @override
  @JsonKey()
  final int currentBeat;

  @override
  String toString() {
    return 'MetronomeState(isPlaying: $isPlaying, bpm: $bpm, currentBeat: $currentBeat)';
  }

  @override
  bool operator ==(Object other) {
    return identical(this, other) ||
        (other.runtimeType == runtimeType &&
            other is _$MetronomeStateImpl &&
            (identical(other.isPlaying, isPlaying) ||
                other.isPlaying == isPlaying) &&
            (identical(other.bpm, bpm) || other.bpm == bpm) &&
            (identical(other.currentBeat, currentBeat) ||
                other.currentBeat == currentBeat));
  }

  @override
  int get hashCode => Object.hash(runtimeType, isPlaying, bpm, currentBeat);

  @JsonKey(ignore: true)
  @override
  @pragma('vm:prefer-inline')
  _$$MetronomeStateImplCopyWith<_$MetronomeStateImpl> get copyWith =>
      __$$MetronomeStateImplCopyWithImpl<_$MetronomeStateImpl>(
          this, _$identity);
}

abstract class _MetronomeState implements MetronomeState {
  const factory _MetronomeState(
      {final bool isPlaying,
      final int bpm,
      final int currentBeat}) = _$MetronomeStateImpl;

  @override
  bool get isPlaying;
  @override
  int get bpm;
  @override
  int get currentBeat;
  @override
  @JsonKey(ignore: true)
  _$$MetronomeStateImplCopyWith<_$MetronomeStateImpl> get copyWith =>
      throw _privateConstructorUsedError;
}
