import '../../lib/sync/models/sync_sample.dart';
import '../../lib/sync/logic/quality_filter.dart';

// Since we cannot use 'test' package, we'll write a simple main function
// that asserts conditions and prints results.

void main() {
  print('Running QualityFilter tests...');

  testHardLimit();
  testStatisticalFiltering();
  testInsufficientHistory();

  print('All tests passed!');
}

void testHardLimit() {
  final filter = QualityFilter(maxRttHardLimit: 100);
  final history = <SyncSample>[];

  // Sample with 50ms RTT (t3-t0 = 50, t2-t1 = 0 for simplicity)
  final validSample = SyncSample(t0: 0, t1: 10, t2: 10, t3: 50); // RTT = 50
  assert(filter.isSampleValid(validSample, history) == true, 'Sample within hard limit should be valid');

  // Sample with 150ms RTT
  final invalidSample = SyncSample(t0: 0, t1: 10, t2: 10, t3: 150); // RTT = 150
  assert(filter.isSampleValid(invalidSample, history) == false, 'Sample exceeding hard limit should be invalid');

  print('testHardLimit passed');
}

void testInsufficientHistory() {
  final filter = QualityFilter(minSamplesForStats: 5);
  final history = <SyncSample>[]; // Empty history

  final sample = SyncSample(t0: 0, t1: 10, t2: 10, t3: 50); // RTT = 50
  assert(filter.isSampleValid(sample, history) == true, 'Should accept samples when history is insufficient');

  print('testInsufficientHistory passed');
}

void testStatisticalFiltering() {
  final filter = QualityFilter(
    maxRttHardLimit: 1000,
    minSamplesForStats: 5,
    stdDevMultiplier: 2.0,
  );

  // Create a history of stable low latency samples (RTT ~ 10ms)
  final history = List.generate(10, (index) {
    return SyncSample(t0: 0, t1: 0, t2: 0, t3: 10); // RTT = 10
  });

  // A sample with RTT = 12ms (close to mean)
  final normalSample = SyncSample(t0: 0, t1: 0, t2: 0, t3: 12);
  assert(filter.isSampleValid(normalSample, history) == true, 'Normal sample should be valid');

  // A sample with RTT = 100ms (spike)
  // Mean = 10, StdDev = 0. Threshold = 10 + 2*0 = 10?
  // Wait, if all are exactly 10, stdDev is 0.
  // In real world there is variance. Let's make history slightly variable.

  final variableHistory = [
    SyncSample(t0: 0, t1: 0, t2: 0, t3: 10),
    SyncSample(t0: 0, t1: 0, t2: 0, t3: 12),
    SyncSample(t0: 0, t1: 0, t2: 0, t3: 8),
    SyncSample(t0: 0, t1: 0, t2: 0, t3: 11),
    SyncSample(t0: 0, t1: 0, t2: 0, t3: 9),
  ];
  // Mean = 50 / 5 = 10.
  // Variance: (0 + 4 + 4 + 1 + 1) / 4 = 10 / 4 = 2.5.
  // StdDev = sqrt(2.5) ~= 1.58.
  // Threshold = 10 + (2.0 * 1.58) = 13.16.

  final validSpike = SyncSample(t0: 0, t1: 0, t2: 0, t3: 13); // RTT = 13 < 13.16
  assert(filter.isSampleValid(validSpike, variableHistory) == true, 'Sample within deviation should be valid');

  final invalidSpike = SyncSample(t0: 0, t1: 0, t2: 0, t3: 20); // RTT = 20 > 13.16
  assert(filter.isSampleValid(invalidSpike, variableHistory) == false, 'Sample outside deviation should be invalid');

  print('testStatisticalFiltering passed');
}
