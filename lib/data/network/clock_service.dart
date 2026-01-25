import 'dart:async';
import 'package:injectable/injectable.dart';
import 'package:bandait/core/di/injection.dart';
import 'package:bandait/domain/repositories/audio_engine.dart';

@singleton
class ClockService {
  // Use lazy getter to avoid initialization order issues
  AudioEngine get _audioEngine => getIt<AudioEngine>();
  int _offset = 0;
  bool _isSynced = false;

  /// Returns the estimated global time (Server Time).
  int now() {
    return DateTime.now().millisecondsSinceEpoch + _offset;
  }

  bool get isSynced => _isSynced;
  int get offset => _offset;

  /// Calculates offset based on NTP formula:
  /// t1: Client Send Time
  /// t2: Server Receive Time
  /// t3: Server Transmit Time
  /// t4: Client Receive Time
  /// Offset = ((t2 - t1) + (t3 - t4)) / 2
  // Metronome
  Timer? _metronomeTimer;
  final _beatController = StreamController<int>.broadcast(); // Emits 1, 2, 3, 4
  Stream<int> get beatStream => _beatController.stream;

  double _bpm = 120;
  int _startTime = 0;
  bool _isPlaying = false;

  void startMetronome(double bpm, int startTime) {
    _bpm = bpm;
    _startTime = startTime;
    _isPlaying = true;
    _rescheduleNextBeat();
  }

  void stopMetronome() {
    _isPlaying = false;
    _metronomeTimer?.cancel();
  }

  void _rescheduleNextBeat() {
    _metronomeTimer?.cancel();
    if (!_isPlaying) return;

    final msPerBeat = (60000 / _bpm).round();
    final now = this.now();

    // Calculate current beat number since start
    // If startTime is future, we wait.
    if (now < _startTime) {
      final delay = _startTime - now;
      _metronomeTimer = Timer(
        Duration(milliseconds: delay),
        _rescheduleNextBeat,
      );
      return;
    }

    final elapsed = now - _startTime;
    final currentBeatIndex = (elapsed / msPerBeat).floor();

    // Calculate time for next beat
    final nextBeatTime = _startTime + ((currentBeatIndex + 1) * msPerBeat);
    final delay = nextBeatTime - now;

    // Schedule exact emit
    _metronomeTimer = Timer(Duration(milliseconds: delay > 0 ? delay : 0), () {
      if (_isPlaying) {
        final beatNr = (currentBeatIndex % 4) + 1; // 1, 2, 3, 4

        // Audio Feedback
        if (beatNr == 1) {
          _audioEngine.playTick();
        } else {
          _audioEngine.playTock();
        }

        _beatController.add(beatNr);
        _rescheduleNextBeat();
      }
    });
  }

  void handleSyncResponse(int t1, int t2, int t3, int t4) {
    final offset = ((t2 - t1) + (t3 - t4)) ~/ 2;
    _offset = offset;
    _isSynced = true;
  }

  void reset() {
    _offset = 0;
    _isSynced = false;
    stopMetronome();
  }
}
