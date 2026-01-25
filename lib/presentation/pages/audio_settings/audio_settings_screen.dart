import 'package:flutter/material.dart';
import 'package:bandait/domain/repositories/audio_engine.dart';
import 'package:bandait/core/di/injection.dart';

class AudioSettingsScreen extends StatefulWidget {
  const AudioSettingsScreen({super.key});

  @override
  State<AudioSettingsScreen> createState() => _AudioSettingsScreenState();
}

class _AudioSettingsScreenState extends State<AudioSettingsScreen> {
  final _audioEngine = getIt<AudioEngine>();

  double _latency = 12.4;
  int _bufferSize = 256;
  int _visualOffset = 15;

  @override
  void initState() {
    super.initState();
    _loadSettings();
  }

  Future<void> _loadSettings() async {
    final offset = await _audioEngine.getGlobalOffset();
    final buffer = await _audioEngine.getBufferLength();
    setState(() {
      _visualOffset = offset;
      _bufferSize = buffer;
    });
  }

  Future<void> _runLatencyTest() async {
    setState(() => _latency = 0);
    await Future.delayed(const Duration(milliseconds: 500));
    final result = await _audioEngine.measureLatency();
    setState(() => _latency = result);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: const Text(
          'AUDIO ENGINE',
          style: TextStyle(
            fontFamily: 'Space Grotesk',
            fontWeight: FontWeight.bold,
            letterSpacing: 1.2,
            color: Colors.white,
          ),
        ),
        backgroundColor: Colors.black,
        leading: IconButton(
          icon: const Icon(Icons.chevron_left, color: Color(0xFFff6600)),
          onPressed: () => Navigator.pop(context),
        ),
        actions: const [
          Icon(Icons.settings_input_component, color: Colors.white),
          SizedBox(width: 16),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Latency Test Module
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: const Color(0xFF0c0c0c),
                border: Border.all(color: const Color(0xFF1a1a1a)),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: const [
                          Text(
                            'LIVE CALIBRATION',
                            style: TextStyle(
                              color: Color(0xFFff6600),
                              fontSize: 10,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          Text(
                            'Latency Test',
                            style: TextStyle(
                              color: Colors.white,
                              fontSize: 20,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                        ],
                      ),
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          const Text(
                            'ROUND-TRIP DELAY',
                            style: TextStyle(
                              color: Color(0xFF666666),
                              fontSize: 10,
                            ),
                          ),
                          Text.rich(
                            TextSpan(
                              text: _latency.toStringAsFixed(1),
                              children: const [
                                TextSpan(
                                  text: ' MS',
                                  style: TextStyle(fontSize: 12),
                                ),
                              ],
                            ),
                            style: const TextStyle(
                              color: Color(0xFFff6600),
                              fontSize: 32,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                  const SizedBox(height: 20),
                  SizedBox(
                    width: double.infinity,
                    height: 56,
                    child: ElevatedButton.icon(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFFff6600),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(8),
                        ),
                      ),
                      icon: const Icon(Icons.sensors, color: Colors.white),
                      label: const Text(
                        'INITIATE PING',
                        style: TextStyle(
                          color: Colors.white,
                          letterSpacing: 1.5,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      onPressed: _runLatencyTest,
                    ),
                  ),
                ],
              ),
            ),

            const SizedBox(height: 24),

            // Buffer Size
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text(
                  'BUFFER SIZE',
                  style: TextStyle(
                    color: Color(0xFF666666),
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 2,
                  ),
                  color: const Color(0xFFff6600).withOpacity(0.1),
                  child: Text(
                    '$_bufferSize SAMPLES',
                    style: const TextStyle(
                      color: Color(0xFFff6600),
                      fontSize: 10,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: const Color(0xFF0c0c0c),
                border: Border.all(color: const Color(0xFF1a1a1a)),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                children: [
                  SliderTheme(
                    data: SliderThemeData(
                      activeTrackColor: const Color(0xFFff6600),
                      thumbColor: const Color(0xFFff6600),
                      inactiveTrackColor: const Color(0xFF1a1a1a),
                      trackHeight: 6,
                    ),
                    child: Slider(
                      value: _bufferSize.toDouble(),
                      min: 64,
                      max: 1024,
                      divisions: 15,
                      label: _bufferSize.toString(),
                      onChanged: (val) async {
                        final newSize = val.round();
                        setState(() => _bufferSize = newSize);
                        await _audioEngine.setBufferLength(newSize);
                      },
                    ),
                  ),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: const [
                      Text(
                        '64 SAMPLES',
                        style: TextStyle(
                          color: Color(0xFF444444),
                          fontSize: 10,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      Text(
                        '1024 SAMPLES',
                        style: TextStyle(
                          color: Color(0xFF444444),
                          fontSize: 10,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),

            const SizedBox(height: 24),

            // Visual Offset
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text(
                  'VISUAL OFFSET',
                  style: TextStyle(
                    color: Color(0xFF666666),
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                Text(
                  '${_visualOffset > 0 ? "+" : ""}$_visualOffset MS',
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: const Color(0xFF0c0c0c),
                border: Border.all(color: const Color(0xFF1a1a1a)),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                children: [
                  SliderTheme(
                    data: SliderThemeData(
                      activeTrackColor: Colors.white.withOpacity(0.2),
                      thumbColor: Colors.white,
                      inactiveTrackColor: const Color(0xFF1a1a1a),
                      trackHeight: 6,
                    ),
                    child: Slider(
                      value: _visualOffset.toDouble(),
                      min: -100,
                      max: 100,
                      onChanged: (val) async {
                        setState(() => _visualOffset = val.round());
                        await _audioEngine.setGlobalOffset(val.round());
                      },
                    ),
                  ),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: const [
                      Text(
                        '-100 MS',
                        style: TextStyle(
                          color: Color(0xFF444444),
                          fontSize: 10,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      Text(
                        '0 MS',
                        style: TextStyle(
                          color: Color(0xFF444444),
                          fontSize: 10,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      Text(
                        '+100 MS',
                        style: TextStyle(
                          color: Color(0xFF444444),
                          fontSize: 10,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildStat(String label, String value) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(
              label,
              style: const TextStyle(
                color: Color(0xFF666666),
                fontSize: 10,
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(width: 8),
            Text(
              value,
              style: TextStyle(
                color: label.contains('CPU')
                    ? const Color(0xFFff6600)
                    : Colors.white,
                fontSize: 12,
                fontWeight: FontWeight.bold,
              ),
            ),
          ],
        ),
        const SizedBox(height: 4),
        Container(
          width: 150,
          height: 4,
          decoration: BoxDecoration(
            color: const Color(0xFF111111),
            borderRadius: BorderRadius.circular(2),
          ),
          child: FractionallySizedBox(
            alignment: Alignment.centerLeft,
            widthFactor: label.contains('CPU') ? 0.42 : 0.18,
            child: Container(
              color: label.contains('CPU')
                  ? const Color(0xFFff6600)
                  : Colors.white,
            ),
          ),
        ),
      ],
    );
  }
}
