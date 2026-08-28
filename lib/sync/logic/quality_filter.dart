import 'dart:math';
import '../models/sync_sample.dart';

/// Filters synchronization samples to ensure high quality clock synchronization.
///
/// It discards samples with high Round Trip Time (RTT) based on statistical analysis
/// of previous samples or hard limits.
class QualityFilter {
  /// Maximum absolute RTT allowed in milliseconds as a hard limit.
  /// Defaults to 500ms (typical high latency on bad WiFi).
  final int maxRttHardLimit;

  /// Multiplier for the standard deviation to determine outliers.
  /// Typically 1.5 to 3.0.
  final double stdDevMultiplier;

  /// Minimum number of samples required to start statistical filtering.
  final int minSamplesForStats;

  /// Minimum standard deviation to assume, to avoid being too strict on
  /// extremely stable networks. Defaults to 1.0.
  final double minStdDev;

  QualityFilter({
    this.maxRttHardLimit = 500,
    this.stdDevMultiplier = 2.0,
    this.minSamplesForStats = 5,
    this.minStdDev = 1.0,
  });

  /// Determines if a [sample] is valid based on the [history] of previous valid samples.
  ///
  /// Returns `true` if the sample should be kept, `false` otherwise.
  bool isSampleValid(SyncSample sample, List<SyncSample> history) {
    // 1. Hard limit check
    if (sample.rtt > maxRttHardLimit || sample.rtt < 0) {
      return false;
    }

    // 2. Statistical check (if enough history)
    if (history.length < minSamplesForStats) {
      // Not enough history to establish a baseline, so we trust it if it passed the hard limit.
      return true;
    }

    // Calculate mean and standard deviation of RTT in history
    final rttStats = _calculateRttStats(history);
    final mean = rttStats.item1;
    final stdDev = max(rttStats.item2, minStdDev); // Apply minimum floor

    // Check if the sample's RTT is within the acceptable range
    // We only care about high RTT spikes, so we check upper bound.
    final threshold = mean + (stdDev * stdDevMultiplier);

    if (sample.rtt > threshold) {
      // RTT is too high compared to recent history (likely a network spike)
      return false;
    }

    return true;
  }

  /// Calculates mean and standard deviation of RTTs from a list of samples.
  /// Returns a Tuple (Mean, StdDev).
  _Stats _calculateRttStats(List<SyncSample> samples) {
    if (samples.isEmpty) return _Stats(0.0, 0.0);

    double sum = 0.0;
    for (var s in samples) {
      sum += s.rtt;
    }
    final mean = sum / samples.length;

    double sumSquaredDiff = 0.0;
    for (var s in samples) {
      final diff = s.rtt - mean;
      sumSquaredDiff += diff * diff;
    }

    // Using sample standard deviation (N-1) if N > 1, else 0
    final divisor = samples.length > 1 ? samples.length - 1 : 1;
    final variance = sumSquaredDiff / divisor;
    final stdDev = sqrt(variance);

    return _Stats(mean, stdDev);
  }
}

class _Stats {
  final double item1; // Mean
  final double item2; // StdDev
  _Stats(this.item1, this.item2);
}
