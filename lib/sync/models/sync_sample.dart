/// Represents a set of timestamps for a synchronization exchange.
///
/// Uses the NTP algorithm variables:
/// t0: Client send time
/// t1: Server receive time
/// t2: Server send time
/// t3: Client receive time
class SyncSample {
  final int t0;
  final int t1;
  final int t2;
  final int t3;

  const SyncSample({
    required this.t0,
    required this.t1,
    required this.t2,
    required this.t3,
  });

  /// Calculates the Round Trip Time (RTT).
  /// RTT = (t3 - t0) - (t2 - t1)
  int get rtt => (t3 - t0) - (t2 - t1);

  /// Calculates the clock offset.
  /// Offset = ((t1 - t0) + (t2 - t3)) / 2
  int get offset => ((t1 - t0) + (t2 - t3)) ~/ 2;

  @override
  String toString() {
    return 'SyncSample(t0: $t0, t1: $t1, t2: $t2, t3: $t3, rtt: $rtt, offset: $offset)';
  }
}
