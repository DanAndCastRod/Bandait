// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'setlist.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

T _$identity<T>(T value) => value;

final _privateConstructorUsedError = UnsupportedError(
    'It seems like you constructed your class using `MyClass._()`. This constructor is only meant to be used by freezed and you are not supposed to need it nor use it.\nPlease check the documentation here for more information: https://github.com/rrousselGit/freezed#adding-getters-and-methods-to-our-models');

/// @nodoc
mixin _$Setlist {
  @HiveField(0)
  String get id => throw _privateConstructorUsedError;
  @HiveField(1)
  String get title => throw _privateConstructorUsedError;
  @HiveField(2)
  DateTime get createdDate => throw _privateConstructorUsedError;
  @HiveField(3)
  List<String> get songIds => throw _privateConstructorUsedError;

  @JsonKey(ignore: true)
  $SetlistCopyWith<Setlist> get copyWith => throw _privateConstructorUsedError;
}

/// @nodoc
abstract class $SetlistCopyWith<$Res> {
  factory $SetlistCopyWith(Setlist value, $Res Function(Setlist) then) =
      _$SetlistCopyWithImpl<$Res, Setlist>;
  @useResult
  $Res call(
      {@HiveField(0) String id,
      @HiveField(1) String title,
      @HiveField(2) DateTime createdDate,
      @HiveField(3) List<String> songIds});
}

/// @nodoc
class _$SetlistCopyWithImpl<$Res, $Val extends Setlist>
    implements $SetlistCopyWith<$Res> {
  _$SetlistCopyWithImpl(this._value, this._then);

  // ignore: unused_field
  final $Val _value;
  // ignore: unused_field
  final $Res Function($Val) _then;

  @pragma('vm:prefer-inline')
  @override
  $Res call({
    Object? id = null,
    Object? title = null,
    Object? createdDate = null,
    Object? songIds = null,
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
      createdDate: null == createdDate
          ? _value.createdDate
          : createdDate // ignore: cast_nullable_to_non_nullable
              as DateTime,
      songIds: null == songIds
          ? _value.songIds
          : songIds // ignore: cast_nullable_to_non_nullable
              as List<String>,
    ) as $Val);
  }
}

/// @nodoc
abstract class _$$SetlistImplCopyWith<$Res> implements $SetlistCopyWith<$Res> {
  factory _$$SetlistImplCopyWith(
          _$SetlistImpl value, $Res Function(_$SetlistImpl) then) =
      __$$SetlistImplCopyWithImpl<$Res>;
  @override
  @useResult
  $Res call(
      {@HiveField(0) String id,
      @HiveField(1) String title,
      @HiveField(2) DateTime createdDate,
      @HiveField(3) List<String> songIds});
}

/// @nodoc
class __$$SetlistImplCopyWithImpl<$Res>
    extends _$SetlistCopyWithImpl<$Res, _$SetlistImpl>
    implements _$$SetlistImplCopyWith<$Res> {
  __$$SetlistImplCopyWithImpl(
      _$SetlistImpl _value, $Res Function(_$SetlistImpl) _then)
      : super(_value, _then);

  @pragma('vm:prefer-inline')
  @override
  $Res call({
    Object? id = null,
    Object? title = null,
    Object? createdDate = null,
    Object? songIds = null,
  }) {
    return _then(_$SetlistImpl(
      id: null == id
          ? _value.id
          : id // ignore: cast_nullable_to_non_nullable
              as String,
      title: null == title
          ? _value.title
          : title // ignore: cast_nullable_to_non_nullable
              as String,
      createdDate: null == createdDate
          ? _value.createdDate
          : createdDate // ignore: cast_nullable_to_non_nullable
              as DateTime,
      songIds: null == songIds
          ? _value._songIds
          : songIds // ignore: cast_nullable_to_non_nullable
              as List<String>,
    ));
  }
}

/// @nodoc

@HiveType(typeId: 3)
class _$SetlistImpl implements _Setlist {
  const _$SetlistImpl(
      {@HiveField(0) required this.id,
      @HiveField(1) required this.title,
      @HiveField(2) required this.createdDate,
      @HiveField(3) final List<String> songIds = const []})
      : _songIds = songIds;

  @override
  @HiveField(0)
  final String id;
  @override
  @HiveField(1)
  final String title;
  @override
  @HiveField(2)
  final DateTime createdDate;
  final List<String> _songIds;
  @override
  @JsonKey()
  @HiveField(3)
  List<String> get songIds {
    if (_songIds is EqualUnmodifiableListView) return _songIds;
    // ignore: implicit_dynamic_type
    return EqualUnmodifiableListView(_songIds);
  }

  @override
  String toString() {
    return 'Setlist(id: $id, title: $title, createdDate: $createdDate, songIds: $songIds)';
  }

  @override
  bool operator ==(Object other) {
    return identical(this, other) ||
        (other.runtimeType == runtimeType &&
            other is _$SetlistImpl &&
            (identical(other.id, id) || other.id == id) &&
            (identical(other.title, title) || other.title == title) &&
            (identical(other.createdDate, createdDate) ||
                other.createdDate == createdDate) &&
            const DeepCollectionEquality().equals(other._songIds, _songIds));
  }

  @override
  int get hashCode => Object.hash(runtimeType, id, title, createdDate,
      const DeepCollectionEquality().hash(_songIds));

  @JsonKey(ignore: true)
  @override
  @pragma('vm:prefer-inline')
  _$$SetlistImplCopyWith<_$SetlistImpl> get copyWith =>
      __$$SetlistImplCopyWithImpl<_$SetlistImpl>(this, _$identity);
}

abstract class _Setlist implements Setlist {
  const factory _Setlist(
      {@HiveField(0) required final String id,
      @HiveField(1) required final String title,
      @HiveField(2) required final DateTime createdDate,
      @HiveField(3) final List<String> songIds}) = _$SetlistImpl;

  @override
  @HiveField(0)
  String get id;
  @override
  @HiveField(1)
  String get title;
  @override
  @HiveField(2)
  DateTime get createdDate;
  @override
  @HiveField(3)
  List<String> get songIds;
  @override
  @JsonKey(ignore: true)
  _$$SetlistImplCopyWith<_$SetlistImpl> get copyWith =>
      throw _privateConstructorUsedError;
}
