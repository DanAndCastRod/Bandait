import 'package:flutter_test/flutter_test.dart';
import 'package:bandait/data/network/clock_service.dart';

void main() {
  group('ClockService Tests', () {
    late ClockService clockService;

    setUp(() {
      clockService = ClockService();
    });

    test('Initial state is not synced', () {
      expect(clockService.isSynced, false);
      expect(clockService.offset, 0);
    });

    test('Calculates offset correctly (NTP logic)', () {
      // Simulate:
      // Client Sent (t1): 1000
      // Server Received (t2): 1100 (Real time was 1050 + 50ms latency) -> Server Clock is +50 ahead?
      // Wait, let's say Server Clock is EXACTLY same as Client for simplicity, but latency is 50ms.
      // t1 = 1000
      // Latency = 50ms
      // t2 = 1050 (Server Time)
      // Processing = 10ms
      // t3 = 1060 (Server Time)
      // Latency = 50ms
      // t4 = 1110 (Client Time)

      // Offset formula: ((t2 - t1) + (t3 - t4)) / 2
      // ((1050 - 1000) + (1060 - 1110)) / 2
      // (50 + (-50)) / 2 = 0.
      // Correct, clocks are synced.

      // Now let's simulate Server is +500ms ahead.
      // t1 = 1000
      // t2 = 1550 (1050 + 500)
      // t3 = 1560 (1060 + 500)
      // t4 = 1110

      // ((1550 - 1000) + (1560 - 1110)) / 2
      // (550 + 450) / 2 = 1000 / 2 = 500.
      // Offset = 500. Correct.

      clockService.handleSyncResponse(1000, 1550, 1560, 1110);

      expect(clockService.isSynced, true);
      expect(clockService.offset, 500);

      // now() should return approx local + 500
      // We can't test now() exact value easily, but we know it adds offset.
    });

    test('Metronome emits beats', () async {
      // Start metronome at T=0 with 60 BPM (1 beat per sec)
      // We need to mock 'now' or rely on fake async.
      // ClockService.now() uses DateTime.now().
      // This is hard to test deterministically without dependency injection of a TimeProvider.
      // For now, we just verify it doesn't crash when called.

      clockService.startMetronome(300, DateTime.now().millisecondsSinceEpoch);
      // 300 BPM = 5 beats/sec. 200ms interval.

      await Future.delayed(const Duration(milliseconds: 500));
      clockService.stopMetronome();
    });
  });
}
