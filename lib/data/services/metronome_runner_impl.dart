import 'dart:async';
import 'dart:developer';
import 'package:injectable/injectable.dart';
import '../../domain/repositories/audio_engine.dart';
import '../../domain/repositories/metronome_runner.dart';

@Singleton(as: MetronomeRunner)
class MetronomeRunnerImpl implements MetronomeRunner {
  final AudioEngine _audioEngine;

  MetronomeRunnerImpl(this._audioEngine);

  Timer? _timer;
  final Stopwatch _stopwatch = Stopwatch();
  final _tickController = StreamController<int>.broadcast();

  int _bpm = 120;
  bool _isPlaying = false;
  int _currentBeat = 1;

  // Drift correction variables
  int _expectedNextTickTime = 0;

  @override
  Stream<int> get onTick => _tickController.stream;

  @override
  bool get isPlaying => _isPlaying;

  @override
  int get bpm => _bpm;

  @override
  void setBpm(int newBpm) {
    if (newBpm < 10) return;
    _bpm = newBpm;
    if (_isPlaying) {
      // Restarting to apply new interval immediately might be jarring,
      // but for simple implementation we can just update the interval for the next tick
      // However, simplified approach: Stop and Start (micro interruption) or smart adjustment.
      // For MVP Sprint 4: We'll just update variable. The _scheduleNextTick method needs to use it.
      // Since we use recursive Timer/Future.delayed for drift correction, it picks up new BPM on next loop.
    }
  }

  @override
  Future<void> start() async {
    await startAt(DateTime.now().millisecondsSinceEpoch);
  }

  @override
  Future<void> startAt(int targetTimestamp) async {
    if (_isPlaying) return;

    // Initialize Audio Engine first
    await _audioEngine.initialize();

    // Calculate delay
    final now = DateTime.now().millisecondsSinceEpoch;
    final delay = targetTimestamp - now;

    if (delay > 0) {
      log('Scheduling Metronome start in ${delay}ms', name: 'MetronomeRunner');
      await Future.delayed(Duration(milliseconds: delay));
    } else {
      log(
        'Target time passed or is now (${delay}ms). Starting immediately.',
        name: 'MetronomeRunner',
      );
    }

    _isPlaying = true;
    _currentBeat = 0; // Will increment to 1 on first tick

    _stopwatch.reset();
    _stopwatch.start();
    _expectedNextTickTime = 0;

    _processTick();
  }

  @override
  void stop() {
    _isPlaying = false;
    _timer?.cancel();
    _stopwatch.stop();
    _currentBeat = 1;
  }

  void _processTick() {
    if (!_isPlaying) return;

    final now = _stopwatch.elapsedMilliseconds;
    // Calculate drift (how late are we?)
    final drift = now - _expectedNextTickTime;

    // Play Sound
    _currentBeat++;
    if (_currentBeat > 4) _currentBeat = 1; // Hardcoded 4/4 for now

    if (_currentBeat == 1) {
      _audioEngine.playTick(); // Strong
    } else {
      _audioEngine.playTock(); // Weak
    }

    _tickController.add(_currentBeat);

    // Calculate interval for next tick based on BPM
    // 60,000 ms / BPM = ms per beat
    final interval = (60000 / _bpm).round();

    _expectedNextTickTime += interval;

    // Schedule next tick, subtracting the drift to get back on track
    // If drift is huge (lag spike), we might queue immediately (0 ms), but never negative.
    var nextDelay = interval - drift;
    if (nextDelay < 0) nextDelay = 0;

    _timer = Timer(Duration(milliseconds: nextDelay), _processTick);
  }
}
