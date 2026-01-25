// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'sync_result.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

T _$identity<T>(T value) => value;

final _privateConstructorUsedError = UnsupportedError(
    'It seems like you constructed your class using `MyClass._()`. This constructor is only meant to be used by freezed and you are not supposed to need it nor use it.\nPlease check the documentation here for more information: https://github.com/rrousselGit/freezed#adding-getters-and-methods-to-our-models');

SyncResult _$SyncResultFromJson(Map<String, dynamic> json) {
  return _SyncResult.fromJson(json);
}

/// @nodoc
mixin _$SyncResult {
  /// Clock offset in milliseconds (add to local time to get server time)
  int get offsetMs => throw _privateConstructorUsedError;

  /// Round-trip time in milliseconds
  int get rttMs => throw _privateConstructorUsedError;

  /// Timestamp when this sample was taken
  int get timestamp => throw _privateConstructorUsedError;

  /// Whether this sample passed quality filters
  bool get isValid => throw _privateConstructorUsedError;

  Map<String, dynamic> toJson() => throw _privateConstructorUsedError;
  @JsonKey(ignore: true)
  $SyncResultCopyWith<SyncResult> get copyWith =>
      throw _privateConstructorUsedError;
}

/// @nodoc
abstract class $SyncResultCopyWith<$Res> {
  factory $SyncResultCopyWith(
          SyncResult value, $Res Function(SyncResult) then) =
      _$SyncResultCopyWithImpl<$Res, SyncResult>;
  @useResult
  $Res call({int offsetMs, int rttMs, int timestamp, bool isValid});
}

/// @nodoc
class _$SyncResultCopyWithImpl<$Res, $Val extends SyncResult>
    implements $SyncResultCopyWith<$Res> {
  _$SyncResultCopyWithImpl(this._value, this._then);

  // ignore: unused_field
  final $Val _value;
  // ignore: unused_field
  final $Res Function($Val) _then;

  @pragma('vm:prefer-inline')
  @override
  $Res call({
    Object? offsetMs = null,
    Object? rttMs = null,
    Object? timestamp = null,
    Object? isValid = null,
  }) {
    return _then(_value.copyWith(
      offsetMs: null == offsetMs
          ? _value.offsetMs
          : offsetMs // ignore: cast_nullable_to_non_nullable
              as int,
      rttMs: null == rttMs
          ? _value.rttMs
          : rttMs // ignore: cast_nullable_to_non_nullable
              as int,
      timestamp: null == timestamp
          ? _value.timestamp
          : timestamp // ignore: cast_nullable_to_non_nullable
              as int,
      isValid: null == isValid
          ? _value.isValid
          : isValid // ignore: cast_nullable_to_non_nullable
              as bool,
    ) as $Val);
  }
}

/// @nodoc
abstract class _$$SyncResultImplCopyWith<$Res>
    implements $SyncResultCopyWith<$Res> {
  factory _$$SyncResultImplCopyWith(
          _$SyncResultImpl value, $Res Function(_$SyncResultImpl) then) =
      __$$SyncResultImplCopyWithImpl<$Res>;
  @override
  @useResult
  $Res call({int offsetMs, int rttMs, int timestamp, bool isValid});
}

/// @nodoc
class __$$SyncResultImplCopyWithImpl<$Res>
    extends _$SyncResultCopyWithImpl<$Res, _$SyncResultImpl>
    implements _$$SyncResultImplCopyWith<$Res> {
  __$$SyncResultImplCopyWithImpl(
      _$SyncResultImpl _value, $Res Function(_$SyncResultImpl) _then)
      : super(_value, _then);

  @pragma('vm:prefer-inline')
  @override
  $Res call({
    Object? offsetMs = null,
    Object? rttMs = null,
    Object? timestamp = null,
    Object? isValid = null,
  }) {
    return _then(_$SyncResultImpl(
      offsetMs: null == offsetMs
          ? _value.offsetMs
          : offsetMs // ignore: cast_nullable_to_non_nullable
              as int,
      rttMs: null == rttMs
          ? _value.rttMs
          : rttMs // ignore: cast_nullable_to_non_nullable
              as int,
      timestamp: null == timestamp
          ? _value.timestamp
          : timestamp // ignore: cast_nullable_to_non_nullable
              as int,
      isValid: null == isValid
          ? _value.isValid
          : isValid // ignore: cast_nullable_to_non_nullable
              as bool,
    ));
  }
}

/// @nodoc
@JsonSerializable()
class _$SyncResultImpl implements _SyncResult {
  const _$SyncResultImpl(
      {required this.offsetMs,
      required this.rttMs,
      required this.timestamp,
      this.isValid = true});

  factory _$SyncResultImpl.fromJson(Map<String, dynamic> json) =>
      _$$SyncResultImplFromJson(json);

  /// Clock offset in milliseconds (add to local time to get server time)
  @override
  final int offsetMs;

  /// Round-trip time in milliseconds
  @override
  final int rttMs;

  /// Timestamp when this sample was taken
  @override
  final int timestamp;

  /// Whether this sample passed quality filters
  @override
  @JsonKey()
  final bool isValid;

  @override
  String toString() {
    return 'SyncResult(offsetMs: $offsetMs, rttMs: $rttMs, timestamp: $timestamp, isValid: $isValid)';
  }

  @override
  bool operator ==(Object other) {
    return identical(this, other) ||
        (other.runtimeType == runtimeType &&
            other is _$SyncResultImpl &&
            (identical(other.offsetMs, offsetMs) ||
                other.offsetMs == offsetMs) &&
            (identical(other.rttMs, rttMs) || other.rttMs == rttMs) &&
            (identical(other.timestamp, timestamp) ||
                other.timestamp == timestamp) &&
            (identical(other.isValid, isValid) || other.isValid == isValid));
  }

  @JsonKey(ignore: true)
  @override
  int get hashCode =>
      Object.hash(runtimeType, offsetMs, rttMs, timestamp, isValid);

  @JsonKey(ignore: true)
  @override
  @pragma('vm:prefer-inline')
  _$$SyncResultImplCopyWith<_$SyncResultImpl> get copyWith =>
      __$$SyncResultImplCopyWithImpl<_$SyncResultImpl>(this, _$identity);

  @override
  Map<String, dynamic> toJson() {
    return _$$SyncResultImplToJson(
      this,
    );
  }
}

abstract class _SyncResult implements SyncResult {
  const factory _SyncResult(
      {required final int offsetMs,
      required final int rttMs,
      required final int timestamp,
      final bool isValid}) = _$SyncResultImpl;

  factory _SyncResult.fromJson(Map<String, dynamic> json) =
      _$SyncResultImpl.fromJson;

  @override

  /// Clock offset in milliseconds (add to local time to get server time)
  int get offsetMs;
  @override

  /// Round-trip time in milliseconds
  int get rttMs;
  @override

  /// Timestamp when this sample was taken
  int get timestamp;
  @override

  /// Whether this sample passed quality filters
  bool get isValid;
  @override
  @JsonKey(ignore: true)
  _$$SyncResultImplCopyWith<_$SyncResultImpl> get copyWith =>
      throw _privateConstructorUsedError;
}
