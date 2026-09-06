import 'dart:async';
import 'package:flutter/material.dart';
import 'package:bandait/domain/models/song.dart';
import '../../../core/di/injection.dart';
import '../../../domain/repositories/metronome_runner.dart';

class StageViewPage extends StatefulWidget {
  final Song song;

  const StageViewPage({super.key, required this.song});

  @override
  State<StageViewPage> createState() => _StageViewPageState();
}

class _StageViewPageState extends State<StageViewPage>
    with SingleTickerProviderStateMixin {
  // Dependencies
  final MetronomeRunner _metronome = getIt<MetronomeRunner>();

  // Stage Theme Colors (Specific to this view)
  static const Color _neonGreen = Color(0xFF00ffa6);
  static const Color _bgBlack = Colors.black;

  // Playback State
  final Stopwatch _stopwatch = Stopwatch();
  Timer? _ticker;
  StreamSubscription<int>? _tickSubscription;
  int _currentIndex = 0;
  int _currentBeat = 1;

  // Animation
  late AnimationController _pulseController;
  // late Animation<double> _pulseAnimation; // Unused for now, logic uses controller directly if needed or just time

  @override
  void initState() {
    super.initState();
    _setupAnimation();
    _startPlayback();
  }

  void _setupAnimation() {
    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 150), // Faster pulse for kick
    );
    _pulseController.addListener(() {
      setState(() {}); // Repaint for pulse
    });
  }

  void _startPlayback() {
    // 1. Audio
    _metronome.setBpm(widget.song.bpm);
    _metronome.start();

    // 2. Visuals (Tick Listener)
    _tickSubscription = _metronome.onTick.listen((beat) {
      setState(() {
        _currentBeat = beat;
        _pulseController.forward(from: 0.0);
      });
    });

    // 3. Lyrics (Smooth Scroll Timer)
    _stopwatch.start();
    _ticker = Timer.periodic(const Duration(milliseconds: 16), (_) {
      _updateCurrentLine();
    });
  }

  void _updateCurrentLine() {
    final currentMs = _stopwatch.elapsedMilliseconds;
    // Find the latest line that has passed
    int newIndex = 0;
    for (int i = 0; i < widget.song.lyrics.length; i++) {
      if (currentMs >= widget.song.lyrics[i].timeMs) {
        newIndex = i;
      } else {
        break;
      }
    }

    if (newIndex != _currentIndex) {
      _currentIndex = newIndex;
      _triggerBeatVisual();
    }
  }

  void _triggerBeatVisual() {
    // Reset pulse or trigger flash in future
  }

  @override
  void dispose() {
    _metronome.stop();
    _tickSubscription?.cancel();
    _ticker?.cancel();
    _stopwatch.stop();
    _pulseController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _bgBlack,
      body: SafeArea(
        child: Column(
          children: [
            _buildHeader(),
            Expanded(child: _buildMainStage()),
            _buildLyricsDeck(),
            _buildSafeZoneIndicator(),
          ],
        ),
      ),
    );
  }

  Widget _buildHeader() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          // Network Status
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            decoration: BoxDecoration(
              color: const Color(0xFF111111),
              borderRadius: BorderRadius.circular(20),
              border: Border.all(color: const Color(0xFF222222)),
            ),
            child: Row(
              children: [
                Container(
                  width: 10,
                  height: 10,
                  decoration: const BoxDecoration(
                    color: _neonGreen,
                    shape: BoxShape.circle,
                    boxShadow: [
                      BoxShadow(
                        color: _neonGreen,
                        blurRadius: 4,
                        spreadRadius: 1,
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                const Text(
                  'LINKED',
                  style: TextStyle(
                    color: _neonGreen,
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                    letterSpacing: 2,
                  ),
                ),
              ],
            ),
          ),
          // Lock/Exit
          GestureDetector(
            onTap: () => Navigator.pop(context),
            child: Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: const Color(0xFF0a0a0a),
                shape: BoxShape.circle,
                border: Border.all(color: const Color(0xFF222222)),
              ),
              child: const Icon(Icons.close, color: Colors.white38, size: 20),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildMainStage() {
    // Current beat simulation (1, 2, 3, 4)
    // final elapsed = _stopwatch.elapsedMilliseconds;
    // final msPerBeat = (60000 / widget.song.bpm).round();
    // final beat = (elapsed ~/ msPerBeat) % 4 + 1; // Replaced by _currentBeat from Audio Engine

    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        // Song Info
        Text(
          'NEXT UP',
          style: TextStyle(
            color: Colors.white.withOpacity(0.6),
            fontSize: 12,
            fontWeight: FontWeight.bold,
            letterSpacing: 3,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          widget.song.title.toUpperCase(),
          textAlign: TextAlign.center,
          style: const TextStyle(
            color: Colors.white,
            fontSize: 32,
            fontWeight: FontWeight.bold,
            letterSpacing: 1,
            height: 1.1,
          ),
        ),
        const SizedBox(height: 12),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
          decoration: BoxDecoration(
            color: Colors.white.withOpacity(0.05),
            borderRadius: BorderRadius.circular(4),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.timer, color: _neonGreen, size: 16),
              const SizedBox(width: 8),
              Text(
                '${widget.song.bpm} BPM',
                style: const TextStyle(
                  color: _neonGreen,
                  fontFamily: 'monospace',
                  fontWeight: FontWeight.bold,
                ),
              ),
            ],
          ),
        ),

        const Spacer(),

        // Visual Metronome
        Stack(
          alignment: Alignment.center,
          children: [
            Container(
              width: 200,
              height: 200,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: _neonGreen.withOpacity(
                  0.05 + (_pulseController.value * 0.1),
                ),
                boxShadow: [
                  BoxShadow(
                    color: _neonGreen.withOpacity(
                      0.1 + (_pulseController.value * 0.2),
                    ),
                    blurRadius: 50 + (_pulseController.value * 20),
                    spreadRadius: 10 + (_pulseController.value * 10),
                  ),
                ],
              ),
            ),
            Text(
              '$_currentBeat',
              style: TextStyle(
                fontSize: 160,
                color: _neonGreen,
                fontWeight: FontWeight.bold,
                height: 0.8,
                shadows: [
                  Shadow(
                    color: _neonGreen,
                    blurRadius: 20 + (_pulseController.value * 30),
                  ),
                ],
              ),
            ),
          ],
        ),

        const SizedBox(height: 24),

        // Beat Dots
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: List.generate(4, (index) {
            final isCurrent = (index + 1) == _currentBeat;
            return Container(
              width: 12,
              height: 12,
              margin: const EdgeInsets.symmetric(horizontal: 8),
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: isCurrent ? _neonGreen : const Color(0xFF222222),
                boxShadow: isCurrent
                    ? [
                        const BoxShadow(
                          color: _neonGreen,
                          blurRadius: 10,
                          spreadRadius: 2,
                        ),
                      ]
                    : null,
              ),
            );
          }),
        ),

        const Spacer(),
      ],
    );
  }

  Widget _buildLyricsDeck() {
    final lyrics = widget.song.lyrics;
    final currentText = lyrics.isNotEmpty && _currentIndex < lyrics.length
        ? lyrics[_currentIndex].text
        : '...';

    final nextText = lyrics.isNotEmpty && _currentIndex + 1 < lyrics.length
        ? lyrics[_currentIndex + 1].text
        : '';

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.only(bottom: 32, left: 24, right: 24),
      child: Column(
        children: [
          // Current Line
          Text(
            currentText,
            textAlign: TextAlign.center,
            style: const TextStyle(
              color: Colors.white,
              fontSize: 32,
              fontWeight: FontWeight.w500,
              height: 1.1,
              letterSpacing: -0.5,
            ),
          ),
          const SizedBox(height: 24),
          // Next Line
          if (nextText.isNotEmpty) ...[
            Container(height: 1, color: Colors.white10),
            const SizedBox(height: 16),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Icon(Icons.skip_next, color: Color(0xFF444444), size: 16),
                const SizedBox(width: 8),
                Text(
                  'NEXT LINE',
                  style: TextStyle(
                    color: const Color(0xFF444444),
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                    letterSpacing: 2,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              nextText,
              textAlign: TextAlign.center,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: Color(0xFF444444), fontSize: 20),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildSafeZoneIndicator() {
    return Container(
      width: 100,
      height: 4,
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        color: const Color(0xFF222222),
        borderRadius: BorderRadius.circular(2),
      ),
    );
  }
}
