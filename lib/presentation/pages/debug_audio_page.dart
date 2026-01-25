import 'package:flutter/material.dart';
import '../../core/di/injection.dart';
import '../../domain/repositories/audio_engine.dart';

class DebugAudioPage extends StatefulWidget {
  const DebugAudioPage({super.key});

  @override
  State<DebugAudioPage> createState() => _DebugAudioPageState();
}

class _DebugAudioPageState extends State<DebugAudioPage> {
  late final AudioEngine _audioEngine;
  bool _isInitialized = false;

  @override
  void initState() {
    super.initState();
    _audioEngine = getIt<AudioEngine>();
  }

  void _initialize() async {
    await _audioEngine.initialize();
    if (mounted) {
      setState(() {
        _isInitialized = true;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Audio Engine Initialized! 🔊')),
      );
    }
  }

  void _playTick() {
    _audioEngine.playTick();
  }

  void _playTock() {
    _audioEngine.playTock();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(title: const Text('Audio Engine Debug')),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (!_isInitialized)
              ElevatedButton(
                onPressed: _initialize,
                // Inherits default app theme (Orange/Space Grotesk)
                child: const Text(
                  'INITIALIZE ENGINE',
                  style: TextStyle(fontSize: 18),
                ),
              ),

            if (_isInitialized) ...[
              Icon(
                Icons.speaker,
                size: 64,
                color: Theme.of(context).primaryColor,
              ),
              const SizedBox(height: 32),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  ElevatedButton(
                    onPressed: _playTick,
                    child: const Text('TICK (Strong)'),
                  ),
                  const SizedBox(width: 24),
                  ElevatedButton(
                    onPressed: _playTock,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Theme.of(context).colorScheme.secondary,
                    ),
                    child: const Text('TOCK (Weak)'),
                  ),
                ],
              ),
              const SizedBox(height: 48),
              const Text(
                'Tap rapidly to test latency',
                style: TextStyle(color: Colors.white54),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
