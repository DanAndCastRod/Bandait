import '../models/sync_result.dart';

abstract class SyncService {
  /// Performs a single sync ping and returns the result.
  Future<SyncResult> performSync();

  /// Stream of sync updates (emits after each successful sync).
  Stream<SyncResult> get onSyncUpdate;

  /// Stream of flash commands (trigger timestamp ms).
  Stream<int> get onFlashCommand;

  /// Returns the current best estimate of the clock offset in milliseconds.
  int get currentOffsetMs;

  /// Returns the current estimated RTT in milliseconds.
  int get currentRttMs;

  /// Returns the jitter (variance in RTT) in milliseconds.
  int get jitterMs;

  /// Local time corrected by the offset.
  int get correctedTimeMs;

  /// Starts periodic synchronization.
  void startPeriodicSync({Duration interval = const Duration(seconds: 5)});

  /// Stops periodic synchronization.
  void stopPeriodicSync();
}
