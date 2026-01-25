// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'metronome_event.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

T _$identity<T>(T value) => value;

final _privateConstructorUsedError = UnsupportedError(
    'It seems like you constructed your class using `MyClass._()`. This constructor is only meant to be used by freezed and you are not supposed to need it nor use it.\nPlease check the documentation here for more information: https://github.com/rrousselGit/freezed#adding-getters-and-methods-to-our-models');

/// @nodoc
mixin _$MetronomeEvent {
  @optionalTypeArgs
  TResult when<TResult extends Object?>({
    required TResult Function(int? startAt) started,
    required TResult Function() stopped,
    required TResult Function(int newBpm) bpmChanged,
    required TResult Function(int beat) ticked,
  }) =>
      throw _privateConstructorUsedError;
  @optionalTypeArgs
  TResult? whenOrNull<TResult extends Object?>({
    TResult? Function(int? startAt)? started,
    TResult? Function()? stopped,
    TResult? Function(int newBpm)? bpmChanged,
    TResult? Function(int beat)? ticked,
  }) =>
      throw _privateConstructorUsedError;
  @optionalTypeArgs
  TResult maybeWhen<TResult extends Object?>({
    TResult Function(int? startAt)? started,
    TResult Function()? stopped,
    TResult Function(int newBpm)? bpmChanged,
    TResult Function(int beat)? ticked,
    required TResult orElse(),
  }) =>
      throw _privateConstructorUsedError;
  @optionalTypeArgs
  TResult map<TResult extends Object?>({
    required TResult Function(Started value) started,
    required TResult Function(Stopped value) stopped,
    required TResult Function(BpmChanged value) bpmChanged,
    required TResult Function(Ticked value) ticked,
  }) =>
      throw _privateConstructorUsedError;
  @optionalTypeArgs
  TResult? mapOrNull<TResult extends Object?>({
    TResult? Function(Started value)? started,
    TResult? Function(Stopped value)? stopped,
    TResult? Function(BpmChanged value)? bpmChanged,
    TResult? Function(Ticked value)? ticked,
  }) =>
      throw _privateConstructorUsedError;
  @optionalTypeArgs
  TResult maybeMap<TResult extends Object?>({
    TResult Function(Started value)? started,
    TResult Function(Stopped value)? stopped,
    TResult Function(BpmChanged value)? bpmChanged,
    TResult Function(Ticked value)? ticked,
    required TResult orElse(),
  }) =>
      throw _privateConstructorUsedError;
}

/// @nodoc
abstract class $MetronomeEventCopyWith<$Res> {
  factory $MetronomeEventCopyWith(
          MetronomeEvent value, $Res Function(MetronomeEvent) then) =
      _$MetronomeEventCopyWithImpl<$Res, MetronomeEvent>;
}

/// @nodoc
class _$MetronomeEventCopyWithImpl<$Res, $Val extends MetronomeEvent>
    implements $MetronomeEventCopyWith<$Res> {
  _$MetronomeEventCopyWithImpl(this._value, this._then);

  // ignore: unused_field
  final $Val _value;
  // ignore: unused_field
  final $Res Function($Val) _then;
}

/// @nodoc
abstract class _$$StartedImplCopyWith<$Res> {
  factory _$$StartedImplCopyWith(
          _$StartedImpl value, $Res Function(_$StartedImpl) then) =
      __$$StartedImplCopyWithImpl<$Res>;
  @useResult
  $Res call({int? startAt});
}

/// @nodoc
class __$$StartedImplCopyWithImpl<$Res>
    extends _$MetronomeEventCopyWithImpl<$Res, _$StartedImpl>
    implements _$$StartedImplCopyWith<$Res> {
  __$$StartedImplCopyWithImpl(
      _$StartedImpl _value, $Res Function(_$StartedImpl) _then)
      : super(_value, _then);

  @pragma('vm:prefer-inline')
  @override
  $Res call({
    Object? startAt = freezed,
  }) {
    return _then(_$StartedImpl(
      startAt: freezed == startAt
          ? _value.startAt
          : startAt // ignore: cast_nullable_to_non_nullable
              as int?,
    ));
  }
}

/// @nodoc

class _$StartedImpl implements Started {
  const _$StartedImpl({this.startAt});

  @override
  final int? startAt;

  @override
  String toString() {
    return 'MetronomeEvent.started(startAt: $startAt)';
  }

  @override
  bool operator ==(Object other) {
    return identical(this, other) ||
        (other.runtimeType == runtimeType &&
            other is _$StartedImpl &&
            (identical(other.startAt, startAt) || other.startAt == startAt));
  }

  @override
  int get hashCode => Object.hash(runtimeType, startAt);

  @JsonKey(ignore: true)
  @override
  @pragma('vm:prefer-inline')
  _$$StartedImplCopyWith<_$StartedImpl> get copyWith =>
      __$$StartedImplCopyWithImpl<_$StartedImpl>(this, _$identity);

  @override
  @optionalTypeArgs
  TResult when<TResult extends Object?>({
    required TResult Function(int? startAt) started,
    required TResult Function() stopped,
    required TResult Function(int newBpm) bpmChanged,
    required TResult Function(int beat) ticked,
  }) {
    return started(startAt);
  }

  @override
  @optionalTypeArgs
  TResult? whenOrNull<TResult extends Object?>({
    TResult? Function(int? startAt)? started,
    TResult? Function()? stopped,
    TResult? Function(int newBpm)? bpmChanged,
    TResult? Function(int beat)? ticked,
  }) {
    return started?.call(startAt);
  }

  @override
  @optionalTypeArgs
  TResult maybeWhen<TResult extends Object?>({
    TResult Function(int? startAt)? started,
    TResult Function()? stopped,
    TResult Function(int newBpm)? bpmChanged,
    TResult Function(int beat)? ticked,
    required TResult orElse(),
  }) {
    if (started != null) {
      return started(startAt);
    }
    return orElse();
  }

  @override
  @optionalTypeArgs
  TResult map<TResult extends Object?>({
    required TResult Function(Started value) started,
    required TResult Function(Stopped value) stopped,
    required TResult Function(BpmChanged value) bpmChanged,
    required TResult Function(Ticked value) ticked,
  }) {
    return started(this);
  }

  @override
  @optionalTypeArgs
  TResult? mapOrNull<TResult extends Object?>({
    TResult? Function(Started value)? started,
    TResult? Function(Stopped value)? stopped,
    TResult? Function(BpmChanged value)? bpmChanged,
    TResult? Function(Ticked value)? ticked,
  }) {
    return started?.call(this);
  }

  @override
  @optionalTypeArgs
  TResult maybeMap<TResult extends Object?>({
    TResult Function(Started value)? started,
    TResult Function(Stopped value)? stopped,
    TResult Function(BpmChanged value)? bpmChanged,
    TResult Function(Ticked value)? ticked,
    required TResult orElse(),
  }) {
    if (started != null) {
      return started(this);
    }
    return orElse();
  }
}

abstract class Started implements MetronomeEvent {
  const factory Started({final int? startAt}) = _$StartedImpl;

  int? get startAt;
  @JsonKey(ignore: true)
  _$$StartedImplCopyWith<_$StartedImpl> get copyWith =>
      throw _privateConstructorUsedError;
}

/// @nodoc
abstract class _$$StoppedImplCopyWith<$Res> {
  factory _$$StoppedImplCopyWith(
          _$StoppedImpl value, $Res Function(_$StoppedImpl) then) =
      __$$StoppedImplCopyWithImpl<$Res>;
}

/// @nodoc
class __$$StoppedImplCopyWithImpl<$Res>
    extends _$MetronomeEventCopyWithImpl<$Res, _$StoppedImpl>
    implements _$$StoppedImplCopyWith<$Res> {
  __$$StoppedImplCopyWithImpl(
      _$StoppedImpl _value, $Res Function(_$StoppedImpl) _then)
      : super(_value, _then);
}

/// @nodoc

class _$StoppedImpl implements Stopped {
  const _$StoppedImpl();

  @override
  String toString() {
    return 'MetronomeEvent.stopped()';
  }

  @override
  bool operator ==(Object other) {
    return identical(this, other) ||
        (other.runtimeType == runtimeType && other is _$StoppedImpl);
  }

  @override
  int get hashCode => runtimeType.hashCode;

  @override
  @optionalTypeArgs
  TResult when<TResult extends Object?>({
    required TResult Function(int? startAt) started,
    required TResult Function() stopped,
    required TResult Function(int newBpm) bpmChanged,
    required TResult Function(int beat) ticked,
  }) {
    return stopped();
  }

  @override
  @optionalTypeArgs
  TResult? whenOrNull<TResult extends Object?>({
    TResult? Function(int? startAt)? started,
    TResult? Function()? stopped,
    TResult? Function(int newBpm)? bpmChanged,
    TResult? Function(int beat)? ticked,
  }) {
    return stopped?.call();
  }

  @override
  @optionalTypeArgs
  TResult maybeWhen<TResult extends Object?>({
    TResult Function(int? startAt)? started,
    TResult Function()? stopped,
    TResult Function(int newBpm)? bpmChanged,
    TResult Function(int beat)? ticked,
    required TResult orElse(),
  }) {
    if (stopped != null) {
      return stopped();
    }
    return orElse();
  }

  @override
  @optionalTypeArgs
  TResult map<TResult extends Object?>({
    required TResult Function(Started value) started,
    required TResult Function(Stopped value) stopped,
    required TResult Function(BpmChanged value) bpmChanged,
    required TResult Function(Ticked value) ticked,
  }) {
    return stopped(this);
  }

  @override
  @optionalTypeArgs
  TResult? mapOrNull<TResult extends Object?>({
    TResult? Function(Started value)? started,
    TResult? Function(Stopped value)? stopped,
    TResult? Function(BpmChanged value)? bpmChanged,
    TResult? Function(Ticked value)? ticked,
  }) {
    return stopped?.call(this);
  }

  @override
  @optionalTypeArgs
  TResult maybeMap<TResult extends Object?>({
    TResult Function(Started value)? started,
    TResult Function(Stopped value)? stopped,
    TResult Function(BpmChanged value)? bpmChanged,
    TResult Function(Ticked value)? ticked,
    required TResult orElse(),
  }) {
    if (stopped != null) {
      return stopped(this);
    }
    return orElse();
  }
}

abstract class Stopped implements MetronomeEvent {
  const factory Stopped() = _$StoppedImpl;
}

/// @nodoc
abstract class _$$BpmChangedImplCopyWith<$Res> {
  factory _$$BpmChangedImplCopyWith(
          _$BpmChangedImpl value, $Res Function(_$BpmChangedImpl) then) =
      __$$BpmChangedImplCopyWithImpl<$Res>;
  @useResult
  $Res call({int newBpm});
}

/// @nodoc
class __$$BpmChangedImplCopyWithImpl<$Res>
    extends _$MetronomeEventCopyWithImpl<$Res, _$BpmChangedImpl>
    implements _$$BpmChangedImplCopyWith<$Res> {
  __$$BpmChangedImplCopyWithImpl(
      _$BpmChangedImpl _value, $Res Function(_$BpmChangedImpl) _then)
      : super(_value, _then);

  @pragma('vm:prefer-inline')
  @override
  $Res call({
    Object? newBpm = null,
  }) {
    return _then(_$BpmChangedImpl(
      null == newBpm
          ? _value.newBpm
          : newBpm // ignore: cast_nullable_to_non_nullable
              as int,
    ));
  }
}

/// @nodoc

class _$BpmChangedImpl implements BpmChanged {
  const _$BpmChangedImpl(this.newBpm);

  @override
  final int newBpm;

  @override
  String toString() {
    return 'MetronomeEvent.bpmChanged(newBpm: $newBpm)';
  }

  @override
  bool operator ==(Object other) {
    return identical(this, other) ||
        (other.runtimeType == runtimeType &&
            other is _$BpmChangedImpl &&
            (identical(other.newBpm, newBpm) || other.newBpm == newBpm));
  }

  @override
  int get hashCode => Object.hash(runtimeType, newBpm);

  @JsonKey(ignore: true)
  @override
  @pragma('vm:prefer-inline')
  _$$BpmChangedImplCopyWith<_$BpmChangedImpl> get copyWith =>
      __$$BpmChangedImplCopyWithImpl<_$BpmChangedImpl>(this, _$identity);

  @override
  @optionalTypeArgs
  TResult when<TResult extends Object?>({
    required TResult Function(int? startAt) started,
    required TResult Function() stopped,
    required TResult Function(int newBpm) bpmChanged,
    required TResult Function(int beat) ticked,
  }) {
    return bpmChanged(newBpm);
  }

  @override
  @optionalTypeArgs
  TResult? whenOrNull<TResult extends Object?>({
    TResult? Function(int? startAt)? started,
    TResult? Function()? stopped,
    TResult? Function(int newBpm)? bpmChanged,
    TResult? Function(int beat)? ticked,
  }) {
    return bpmChanged?.call(newBpm);
  }

  @override
  @optionalTypeArgs
  TResult maybeWhen<TResult extends Object?>({
    TResult Function(int? startAt)? started,
    TResult Function()? stopped,
    TResult Function(int newBpm)? bpmChanged,
    TResult Function(int beat)? ticked,
    required TResult orElse(),
  }) {
    if (bpmChanged != null) {
      return bpmChanged(newBpm);
    }
    return orElse();
  }

  @override
  @optionalTypeArgs
  TResult map<TResult extends Object?>({
    required TResult Function(Started value) started,
    required TResult Function(Stopped value) stopped,
    required TResult Function(BpmChanged value) bpmChanged,
    required TResult Function(Ticked value) ticked,
  }) {
    return bpmChanged(this);
  }

  @override
  @optionalTypeArgs
  TResult? mapOrNull<TResult extends Object?>({
    TResult? Function(Started value)? started,
    TResult? Function(Stopped value)? stopped,
    TResult? Function(BpmChanged value)? bpmChanged,
    TResult? Function(Ticked value)? ticked,
  }) {
    return bpmChanged?.call(this);
  }

  @override
  @optionalTypeArgs
  TResult maybeMap<TResult extends Object?>({
    TResult Function(Started value)? started,
    TResult Function(Stopped value)? stopped,
    TResult Function(BpmChanged value)? bpmChanged,
    TResult Function(Ticked value)? ticked,
    required TResult orElse(),
  }) {
    if (bpmChanged != null) {
      return bpmChanged(this);
    }
    return orElse();
  }
}

abstract class BpmChanged implements MetronomeEvent {
  const factory BpmChanged(final int newBpm) = _$BpmChangedImpl;

  int get newBpm;
  @JsonKey(ignore: true)
  _$$BpmChangedImplCopyWith<_$BpmChangedImpl> get copyWith =>
      throw _privateConstructorUsedError;
}

/// @nodoc
abstract class _$$TickedImplCopyWith<$Res> {
  factory _$$TickedImplCopyWith(
          _$TickedImpl value, $Res Function(_$TickedImpl) then) =
      __$$TickedImplCopyWithImpl<$Res>;
  @useResult
  $Res call({int beat});
}

/// @nodoc
class __$$TickedImplCopyWithImpl<$Res>
    extends _$MetronomeEventCopyWithImpl<$Res, _$TickedImpl>
    implements _$$TickedImplCopyWith<$Res> {
  __$$TickedImplCopyWithImpl(
      _$TickedImpl _value, $Res Function(_$TickedImpl) _then)
      : super(_value, _then);

  @pragma('vm:prefer-inline')
  @override
  $Res call({
    Object? beat = null,
  }) {
    return _then(_$TickedImpl(
      null == beat
          ? _value.beat
          : beat // ignore: cast_nullable_to_non_nullable
              as int,
    ));
  }
}

/// @nodoc

class _$TickedImpl implements Ticked {
  const _$TickedImpl(this.beat);

  @override
  final int beat;

  @override
  String toString() {
    return 'MetronomeEvent.ticked(beat: $beat)';
  }

  @override
  bool operator ==(Object other) {
    return identical(this, other) ||
        (other.runtimeType == runtimeType &&
            other is _$TickedImpl &&
            (identical(other.beat, beat) || other.beat == beat));
  }

  @override
  int get hashCode => Object.hash(runtimeType, beat);

  @JsonKey(ignore: true)
  @override
  @pragma('vm:prefer-inline')
  _$$TickedImplCopyWith<_$TickedImpl> get copyWith =>
      __$$TickedImplCopyWithImpl<_$TickedImpl>(this, _$identity);

  @override
  @optionalTypeArgs
  TResult when<TResult extends Object?>({
    required TResult Function(int? startAt) started,
    required TResult Function() stopped,
    required TResult Function(int newBpm) bpmChanged,
    required TResult Function(int beat) ticked,
  }) {
    return ticked(beat);
  }

  @override
  @optionalTypeArgs
  TResult? whenOrNull<TResult extends Object?>({
    TResult? Function(int? startAt)? started,
    TResult? Function()? stopped,
    TResult? Function(int newBpm)? bpmChanged,
    TResult? Function(int beat)? ticked,
  }) {
    return ticked?.call(beat);
  }

  @override
  @optionalTypeArgs
  TResult maybeWhen<TResult extends Object?>({
    TResult Function(int? startAt)? started,
    TResult Function()? stopped,
    TResult Function(int newBpm)? bpmChanged,
    TResult Function(int beat)? ticked,
    required TResult orElse(),
  }) {
    if (ticked != null) {
      return ticked(beat);
    }
    return orElse();
  }

  @override
  @optionalTypeArgs
  TResult map<TResult extends Object?>({
    required TResult Function(Started value) started,
    required TResult Function(Stopped value) stopped,
    required TResult Function(BpmChanged value) bpmChanged,
    required TResult Function(Ticked value) ticked,
  }) {
    return ticked(this);
  }

  @override
  @optionalTypeArgs
  TResult? mapOrNull<TResult extends Object?>({
    TResult? Function(Started value)? started,
    TResult? Function(Stopped value)? stopped,
    TResult? Function(BpmChanged value)? bpmChanged,
    TResult? Function(Ticked value)? ticked,
  }) {
    return ticked?.call(this);
  }

  @override
  @optionalTypeArgs
  TResult maybeMap<TResult extends Object?>({
    TResult Function(Started value)? started,
    TResult Function(Stopped value)? stopped,
    TResult Function(BpmChanged value)? bpmChanged,
    TResult Function(Ticked value)? ticked,
    required TResult orElse(),
  }) {
    if (ticked != null) {
      return ticked(this);
    }
    return orElse();
  }
}

abstract class Ticked implements MetronomeEvent {
  const factory Ticked(final int beat) = _$TickedImpl;

  int get beat;
  @JsonKey(ignore: true)
  _$$TickedImplCopyWith<_$TickedImpl> get copyWith =>
      throw _privateConstructorUsedError;
}
