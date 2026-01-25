import 'dart:async';
import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';
import '../../../domain/models/song.dart';
import '../../../core/di/injection.dart';
import '../../../core/utils/lrc_parser.dart';
import '../../../domain/repositories/song_repository.dart';

class LyricEditorPage extends StatefulWidget {
  final Song song;
  const LyricEditorPage({super.key, required this.song});

  @override
  State<LyricEditorPage> createState() => _LyricEditorPageState();
}

class _LyricEditorPageState extends State<LyricEditorPage> {
  late Song _song;
  final SongRepository _repository = getIt<SongRepository>();

  // Playback State
  final Stopwatch _stopwatch = Stopwatch();
  Timer? _ticker;
  int _currentIndex = 0;
  final ScrollController _scrollController = ScrollController();

  @override
  void initState() {
    super.initState();
    _song = widget.song;
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _stopwatch.stop();
    _scrollController.dispose();
    super.dispose();
  }

  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.darkBackground,
      appBar: _buildAppBar(),
      body: Column(
        children: [
          _buildInfoBar(),
          Expanded(child: _buildSplitView()),
          _buildWaveformFooter(),
        ],
      ),
    );
  }

  PreferredSizeWidget _buildAppBar() {
    return AppBar(
      backgroundColor: AppTheme.cardBackground,
      title: Column(
        children: [
          Text(
            _song.title.toUpperCase(),
            style: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.bold,
              letterSpacing: 1.0,
            ),
          ),
          Text(
            'STUDIO MIX V2', // Placeholder
            style: const TextStyle(
              fontSize: 10,
              color: AppTheme.primaryColor,
              letterSpacing: 2.0,
            ),
          ),
        ],
      ),
      actions: [
        Padding(
          padding: const EdgeInsets.only(right: 16.0),
          child: ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: AppTheme.primaryColor,
              foregroundColor: Colors.black,
              textStyle: const TextStyle(
                fontWeight: FontWeight.bold,
                fontSize: 10,
              ),
            ),
            onPressed: () {},
            child: const Text('EXPORT LRC'),
          ),
        ),
      ],
    );
  }

  Widget _buildInfoBar() {
    return Container(
      color: AppTheme.cardBackground.withOpacity(0.5),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          const Text(
            'REC MODE: ACTIVE',
            style: TextStyle(
              color: AppTheme.primaryColor,
              fontSize: 10,
              fontWeight: FontWeight.bold,
              letterSpacing: 3.0,
            ),
          ),
          Text(
            'BUFFER: 12ms',
            style: TextStyle(
              color: Colors.white.withOpacity(0.4),
              fontSize: 10,
              fontFamily: 'monospace',
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSplitView() {
    return Row(
      children: [
        // Left: Lyrics List
        Expanded(
          child: Container(
            decoration: const BoxDecoration(
              border: Border(right: BorderSide(color: Colors.white10)),
            ),
            child: _song.lyrics.isEmpty
                ? Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const Icon(
                          Icons.text_snippet,
                          size: 48,
                          color: Colors.white24,
                        ),
                        const SizedBox(height: 16),
                        Text(
                          'NO LYRICS FOUND',
                          style: TextStyle(
                            color: Colors.white.withOpacity(0.5),
                            letterSpacing: 2,
                            fontSize: 12,
                          ),
                        ),
                        const SizedBox(height: 24),
                        ElevatedButton.icon(
                          style: ElevatedButton.styleFrom(
                            backgroundColor: AppTheme.technicalBorder,
                            foregroundColor: AppTheme.primaryColor,
                          ),
                          onPressed: _showPasteDialog,
                          icon: const Icon(Icons.paste),
                          label: const Text('PASTE TEXT / LRC'),
                        ),
                      ],
                    ),
                  )
                : ListView.builder(
                    controller: _scrollController,
                    itemCount: _song.lyrics.length,
                    itemBuilder: (context, index) {
                      final line = _song.lyrics[index];
                      return _LyricItem(
                        timestamp: _formatTime(line.timeMs),
                        text: line.text,
                        isActive: index == _currentIndex,
                      );
                    },
                  ),
          ),
        ),
        // Right: Timestamping Tool
        Expanded(
          child: Container(
            color: AppTheme.cardBackground,
            padding: const EdgeInsets.all(16),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Column(
                  children: [
                    Text(
                      'CURRENT TARGET',
                      style: TextStyle(
                        color: Colors.white.withOpacity(0.5),
                        fontSize: 10,
                        fontWeight: FontWeight.bold,
                        letterSpacing: 2.0,
                      ),
                    ),
                    const SizedBox(height: 16),
                    Container(
                      padding: const EdgeInsets.all(16),
                      decoration: BoxDecoration(
                        color: AppTheme.darkBackground,
                        border: Border.all(color: Colors.white10),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Column(
                        children: [
                          const Text(
                            'WAITING...',
                            style: TextStyle(
                              color: AppTheme.primaryColor,
                              fontFamily: 'monospace',
                              fontSize: 12,
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            _currentIndex < _song.lyrics.length
                                ? '"${_song.lyrics[_currentIndex].text}"'
                                : 'END OF SONG',
                            textAlign: TextAlign.center,
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 14,
                              fontStyle: FontStyle.italic,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                // Big Button
                GestureDetector(
                  onTap: _markBeat,
                  child: Container(
                    width: 128,
                    height: 128,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: AppTheme.primaryColor.withOpacity(0.05),
                      border: Border.all(
                        color: AppTheme.primaryColor.withOpacity(0.2),
                        width: 2,
                      ),
                    ),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: const [
                        Icon(
                          Icons.timer,
                          color: AppTheme.primaryColor,
                          size: 48,
                        ),
                        Text(
                          'MARK BEAT',
                          style: TextStyle(
                            color: AppTheme.primaryColor,
                            fontSize: 10,
                            fontWeight: FontWeight.bold,
                            letterSpacing: 2.0,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),

                // Stats
                Column(
                  children: [
                    _buildStatRow('LAST STAMP', '00:12.45'),
                    _buildStatRow('CONFIDENCE', '98%'),
                  ],
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildStatRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            label,
            style: TextStyle(
              color: Colors.white38,
              fontSize: 10,
              fontFamily: 'monospace',
            ),
          ),
          Text(
            value,
            style: const TextStyle(
              color: AppTheme.primaryColor,
              fontSize: 10,
              fontFamily: 'monospace',
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildWaveformFooter() {
    return Container(
      height: 140,
      decoration: const BoxDecoration(
        color: AppTheme.cardBackground,
        border: Border(top: BorderSide(color: Colors.white10)),
      ),
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          // Waveform placeholder
          Expanded(
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.end,
              children: List.generate(30, (index) {
                final height = (index % 5 + 1) * 10.0;
                final isActive = index > 10 && index < 20;
                return Container(
                  width: 4,
                  height: height,
                  margin: const EdgeInsets.symmetric(horizontal: 2),
                  decoration: BoxDecoration(
                    color: isActive ? AppTheme.primaryColor : Colors.white10,
                    borderRadius: BorderRadius.circular(2),
                    boxShadow: isActive
                        ? [
                            BoxShadow(
                              color: AppTheme.primaryColor.withOpacity(0.5),
                              blurRadius: 4,
                            ),
                          ]
                        : null,
                  ),
                );
              }),
            ),
          ),
          const SizedBox(height: 16),
          // Controls
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                _formatTime(_stopwatch.elapsedMilliseconds),
                style: const TextStyle(
                  color: AppTheme.primaryColor,
                  fontFamily: 'monospace',
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                ),
              ),
              Row(
                children: [
                  IconButton(
                    onPressed: () {},
                    icon: const Icon(Icons.replay_5, color: Colors.white54),
                  ),
                  const SizedBox(width: 16),
                  GestureDetector(
                    onTap: _togglePlayback,
                    child: Container(
                      width: 48,
                      height: 48,
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Icon(
                        _stopwatch.isRunning ? Icons.pause : Icons.play_arrow,
                        color: Colors.black,
                        size: 32,
                      ),
                    ),
                  ),
                  const SizedBox(width: 16),
                  IconButton(
                    onPressed: () {},
                    icon: const Icon(Icons.forward_5, color: Colors.white54),
                  ),
                ],
              ),
              Text(
                _formatTime(_song.durationMs),
                style: const TextStyle(
                  color: Colors.white30,
                  fontFamily: 'monospace',
                  fontSize: 18,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  void _togglePlayback() {
    setState(() {
      if (_stopwatch.isRunning) {
        _stopwatch.stop();
        _ticker?.cancel();
      } else {
        _stopwatch.start();
        _ticker = Timer.periodic(const Duration(milliseconds: 32), (_) {
          setState(() {});
        });
      }
    });
  }

  Future<void> _markBeat() async {
    if (!_stopwatch.isRunning) _togglePlayback();

    if (_currentIndex < _song.lyrics.length) {
      final currentLine = _song.lyrics[_currentIndex];
      final updatedLine = currentLine.copyWith(
        timeMs: _stopwatch.elapsedMilliseconds,
      );

      final updatedLyrics = List<LyricLine>.from(_song.lyrics);
      updatedLyrics[_currentIndex] = updatedLine;

      final updatedSong = _song.copyWith(lyrics: updatedLyrics);

      setState(() {
        _song = updatedSong;
        _currentIndex++;
      });

      // Auto-scroll
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          _currentIndex * 72.0, // approx height of item
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      }

      await _repository.saveSong(updatedSong);
    }
  }

  String _formatTime(int ms) {
    final duration = Duration(milliseconds: ms);
    final minutes = duration.inMinutes.remainder(60).toString().padLeft(2, '0');
    final seconds = duration.inSeconds.remainder(60).toString().padLeft(2, '0');
    final millis = (duration.inMilliseconds % 1000 ~/ 10).toString().padLeft(
      2,
      '0',
    );
    return '[$minutes:$seconds.$millis]';
  }

  void _showPasteDialog() {
    final TextEditingController controller = TextEditingController();
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: AppTheme.cardBackground,
        title: const Text(
          'Paste Lyrics',
          style: TextStyle(color: Colors.white),
        ),
        content: TextField(
          controller: controller,
          maxLines: 10,
          style: const TextStyle(color: Colors.white, fontFamily: 'monospace'),
          decoration: const InputDecoration(
            hintText: 'Paste lyrics or LRC content...',
            hintStyle: TextStyle(color: Colors.grey),
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('CANCEL'),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: AppTheme.primaryColor,
            ),
            onPressed: () async {
              if (controller.text.isNotEmpty) {
                try {
                  // Parse new song data but keep ID
                  final parsedSong = LrcParser.parse(
                    controller.text,
                    defaultId: _song.id,
                  );

                  // Merge parsed data into current song
                  final updatedSong = _song.copyWith(
                    title: parsedSong.title != 'Unknown Title'
                        ? parsedSong.title
                        : _song.title,
                    artist: parsedSong.artist != 'Unknown Artist'
                        ? parsedSong.artist
                        : _song.artist,
                    bpm: parsedSong.bpm != 120 ? parsedSong.bpm : _song.bpm,
                    lyrics: parsedSong.lyrics,
                    durationMs: parsedSong.durationMs,
                  );

                  // Save and Update State
                  await _repository.saveSong(updatedSong);
                  setState(() {
                    _song = updatedSong;
                  });

                  if (mounted) {
                    Navigator.pop(context);
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Lyrics updated!')),
                    );
                  }
                } catch (e) {
                  ScaffoldMessenger.of(
                    context,
                  ).showSnackBar(SnackBar(content: Text('Error: $e')));
                }
              }
            },
            child: const Text('SAVE'),
          ),
        ],
      ),
    );
  }
}

class _LyricItem extends StatelessWidget {
  final String timestamp;
  final String text;
  final bool isActive;

  const _LyricItem({
    required this.timestamp,
    required this.text,
    required this.isActive,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: isActive
            ? AppTheme.primaryColor.withOpacity(0.1)
            : Colors.transparent,
        border: isActive
            ? const Border(
                left: BorderSide(color: AppTheme.primaryColor, width: 2),
              )
            : Border(bottom: BorderSide(color: Colors.white.withOpacity(0.05))),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            timestamp,
            style: const TextStyle(
              color: AppTheme.primaryColor,
              fontSize: 10,
              fontWeight: FontWeight.bold,
              fontFamily: 'monospace',
            ),
          ),
          const SizedBox(height: 4),
          Text(text, style: const TextStyle(color: Colors.white, fontSize: 14)),
        ],
      ),
    );
  }
}
