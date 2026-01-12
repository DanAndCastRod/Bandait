import '../entities/sync_stats.dart';

abstract class SyncRepository {
  Stream<SyncStats> get statsStream;
  Future<void> triggerFlashTest();
  Stream<bool> get flashTriggerStream;
}
