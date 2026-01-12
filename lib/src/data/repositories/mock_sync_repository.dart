import 'dart:async';
import 'dart:math';
import '../../domain/entities/sync_stats.dart';
import '../../domain/repositories/sync_repository.dart';

class MockSyncRepository implements SyncRepository {
  final _statsController = StreamController<SyncStats>.broadcast();
  final _flashController = StreamController<bool>.broadcast();
  Timer? _timer;
  final Random _random = Random();

  MockSyncRepository() {
    _startSimulatingUpdates();
  }

  void _startSimulatingUpdates() {
    // Simulate updates every 1 second
    _timer = Timer.periodic(const Duration(seconds: 1), (timer) {
      final stats = SyncStats(
        offsetMs: -10 + _random.nextInt(5), // -10ms to -5ms
        rttMs: 2 + _random.nextInt(3),      // 2ms to 5ms
        jitterMs: _random.nextInt(2),       // 0ms or 1ms
        lastUpdated: DateTime.now(),
      );
      _statsController.add(stats);
    });
  }

  @override
  Stream<SyncStats> get statsStream => _statsController.stream;

  @override
  Stream<bool> get flashTriggerStream => _flashController.stream;

  @override
  Future<void> triggerFlashTest() async {
    // Simulate network delay
    await Future.delayed(const Duration(milliseconds: 50));
    _flashController.add(true);

    // Reset flash state after a short duration (e.g., 200ms)
    Future.delayed(const Duration(milliseconds: 200), () {
       _flashController.add(false);
    });
  }

  void dispose() {
    _timer?.cancel();
    _statsController.close();
    _flashController.close();
  }
}
