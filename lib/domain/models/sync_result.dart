import 'package:freezed_annotation/freezed_annotation.dart';

part 'sync_result.freezed.dart';
part 'sync_result.g.dart';

@freezed
class SyncResult with _$SyncResult {
  const factory SyncResult({
    /// Clock offset in milliseconds (add to local time to get server time)
    required int offsetMs,

    /// Round-trip time in milliseconds
    required int rttMs,

    /// Timestamp when this sample was taken
    required int timestamp,

    /// Whether this sample passed quality filters
    @Default(true) bool isValid,
  }) = _SyncResult;

  factory SyncResult.fromJson(Map<String, dynamic> json) =>
      _$SyncResultFromJson(json);
}
