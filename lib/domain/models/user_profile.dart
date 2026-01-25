import 'package:freezed_annotation/freezed_annotation.dart';
import 'package:hive/hive.dart';

part 'user_profile.freezed.dart';
part 'user_profile.g.dart';

@freezed
class UserProfile with _$UserProfile {
  @HiveType(typeId: 4)
  const factory UserProfile({
    @HiveField(0) required String id,
    @HiveField(1) required String name,
    @HiveField(2)
    required String instrument, // guitar, drums, vocals, bass, keys, etc.
    @HiveField(3) required int colorValue, // Store Color.value
  }) = _UserProfile;

  factory UserProfile.fromJson(Map<String, dynamic> json) =>
      _$UserProfileFromJson(json);
}
