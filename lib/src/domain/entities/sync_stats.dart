import 'package:equatable/equatable.dart';

class SyncStats extends Equatable {
  final int offsetMs;
  final int rttMs;
  final int jitterMs;
  final DateTime lastUpdated;

  const SyncStats({
    required this.offsetMs,
    required this.rttMs,
    required this.jitterMs,
    required this.lastUpdated,
  });

  factory SyncStats.empty() {
    return SyncStats(
      offsetMs: 0,
      rttMs: 0,
      jitterMs: 0,
      lastUpdated: DateTime.now(),
    );
  }

  @override
  List<Object?> get props => [offsetMs, rttMs, jitterMs, lastUpdated];

  @override
  String toString() {
    return 'SyncStats(offset: ${offsetMs}ms, rtt: ${rttMs}ms, jitter: ${jitterMs}ms)';
  }
}
