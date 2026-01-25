import 'package:flutter/material.dart';
import '../../../core/di/injection.dart';
import '../../../domain/models/song.dart';
import '../../../domain/repositories/song_repository.dart';
import '../stage/stage_view_page.dart';
import 'lyric_editor_page.dart';
import '../../theme/app_theme.dart';
import '../../../core/utils/lrc_parser.dart';
// Added Imports
import 'setlist_library_page.dart';
import '../audio_settings/audio_settings_screen.dart';
import 'package:intl/intl.dart';

class SongLibraryPage extends StatefulWidget {
  const SongLibraryPage({super.key});

  @override
  State<SongLibraryPage> createState() => _SongLibraryPageState();
}

class _SongLibraryPageState extends State<SongLibraryPage> {
  final SongRepository _repository = getIt<SongRepository>();
  String _searchQuery = '';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.darkBackground,
      appBar: _buildAppBar(),
      body: Column(
        children: [
          _buildFilterChips(),
          Expanded(child: _buildSongList()),
        ],
      ),
      floatingActionButton: _buildFab(),
      bottomNavigationBar: _buildBottomNav(),
    );
  }

  PreferredSizeWidget _buildAppBar() {
    return AppBar(
      backgroundColor: AppTheme.cardBackground.withOpacity(0.8),
      elevation: 0,
      title: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: AppTheme.primaryColor.withOpacity(0.2),
              borderRadius: BorderRadius.circular(4),
            ),
            child: const Icon(
              Icons.queue_music,
              color: AppTheme.primaryColor,
              size: 20,
            ),
          ),
          const SizedBox(width: 12),
          const Text(
            'LIBRARY',
            style: TextStyle(
              fontFamily: 'Space Grotesk',
              fontWeight: FontWeight.bold,
              letterSpacing: 1.2,
              fontStyle: FontStyle.italic,
            ),
          ),
        ],
      ),
      actions: [
        IconButton(
          icon: const Icon(Icons.cloud_download, color: AppTheme.primaryColor),
          onPressed: () {
            _showImportDialog(context);
          },
        ),
      ],
      bottom: PreferredSize(
        preferredSize: const Size.fromHeight(60),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: TextField(
            onChanged: (val) => setState(() => _searchQuery = val),
            style: const TextStyle(color: Colors.white),
            decoration: InputDecoration(
              filled: true,
              fillColor: AppTheme.technicalBorder,
              hintText: 'Search by song, artist...',
              hintStyle: TextStyle(color: Colors.grey[600]),
              prefixIcon: Icon(Icons.search, color: Colors.grey[600]),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(8),
                borderSide: BorderSide.none,
              ),
              contentPadding: const EdgeInsets.symmetric(vertical: 0),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildFilterChips() {
    final tags = ['All Tracks', 'Genre', 'BPM', 'Key', 'Recent'];
    return Container(
      height: 50,
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        itemCount: tags.length,
        separatorBuilder: (_, __) => const SizedBox(width: 8),
        itemBuilder: (context, index) {
          final isSelected = index == 0;
          return Container(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: isSelected
                  ? AppTheme.primaryColor
                  : AppTheme.cardBackground,
              borderRadius: BorderRadius.circular(24),
              border: isSelected ? null : Border.all(color: Colors.white10),
              boxShadow: isSelected
                  ? [
                      BoxShadow(
                        color: AppTheme.primaryColor.withOpacity(0.3),
                        blurRadius: 8,
                      ),
                    ]
                  : null,
            ),
            child: Text(
              tags[index].toUpperCase(),
              style: TextStyle(
                color: isSelected ? Colors.black : Colors.grey[400],
                fontWeight: FontWeight.bold,
                fontSize: 12,
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _buildSongList() {
    return StreamBuilder<List<Song>>(
      stream: _repository.watchSongs(),
      builder: (context, snapshot) {
        if (!snapshot.hasData) {
          return const Center(
            child: CircularProgressIndicator(color: AppTheme.primaryColor),
          );
        }

        final songs = snapshot.data!.where((s) {
          return s.title.toLowerCase().contains(_searchQuery.toLowerCase()) ||
              s.artist.toLowerCase().contains(_searchQuery.toLowerCase());
        }).toList();

        if (songs.isEmpty) {
          return Center(
            child: Text(
              'NO TRACKS FOUND',
              style: TextStyle(color: Colors.grey[700], letterSpacing: 2),
            ),
          );
        }

        return ListView.separated(
          padding: const EdgeInsets.all(16),
          itemCount: songs.length,
          separatorBuilder: (_, __) => const SizedBox(height: 12),
          itemBuilder: (context, index) => _SongCard(song: songs[index]),
        );
      },
    );
  }

  Widget _buildFab() {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        FloatingActionButton.small(
          heroTag: 'import',
          backgroundColor: AppTheme.cardBackground,
          foregroundColor: Colors.white,
          onPressed: () {
            _showImportDialog(context);
          },
          child: const Icon(Icons.file_upload),
        ),
        const SizedBox(height: 16),
        FloatingActionButton(
          heroTag: 'add',
          backgroundColor: AppTheme.primaryColor,
          foregroundColor: Colors.black,
          onPressed: () {
            final newSong = Song(
              id: DateTime.now().millisecondsSinceEpoch.toString(),
              title: 'New Song',
              artist: 'Unknown Artist',
              bpm: 120,
              lyrics: [],
            );
            Navigator.push(
              context,
              MaterialPageRoute(builder: (_) => LyricEditorPage(song: newSong)),
            );
          },
          child: const Icon(Icons.add, size: 32),
        ),
      ],
    );
  }

  Widget _buildBottomNav() {
    return Container(
      height: 60,
      decoration: const BoxDecoration(
        color: AppTheme.cardBackground,
        border: Border(top: BorderSide(color: Colors.white10)),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceAround,
        children: [
          _NavIcon(
            icon: Icons.library_music,
            label: 'Library',
            isActive: true,
            onTap: () {},
          ),
          _NavIcon(
            icon: Icons.playlist_play,
            label: 'Setlists',
            onTap: () {
              Navigator.push(
                context,
                MaterialPageRoute(builder: (_) => const SetlistLibraryPage()),
              );
            },
          ),
          _NavIcon(
            icon: Icons.groups,
            label: 'Band',
            onTap: () {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(
                  content: Text('Multi-user Band features coming in Phase 3'),
                ),
              );
            },
          ),
          _NavIcon(
            icon: Icons.settings,
            label: 'Settings',
            onTap: () {
              Navigator.push(
                context,
                MaterialPageRoute(builder: (_) => const AudioSettingsScreen()),
              );
            },
          ),
        ],
      ),
    );
  }

  void _showImportDialog(BuildContext context) {
    final TextEditingController controller = TextEditingController();

    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: AppTheme.cardBackground,
        title: const Text('Import LRC', style: TextStyle(color: Colors.white)),
        content: TextField(
          controller: controller,
          maxLines: 10,
          style: const TextStyle(color: Colors.white, fontFamily: 'monospace'),
          decoration: const InputDecoration(
            hintText: 'Paste LRC content here...',
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
                  final song = LrcParser.parse(controller.text);
                  await _repository.saveSong(song);
                  if (mounted) {
                    Navigator.pop(context);
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: Text('Imported: ${song.title}')),
                    );
                  }
                } catch (e) {
                  ScaffoldMessenger.of(
                    context,
                  ).showSnackBar(SnackBar(content: Text('Error: $e')));
                }
              }
            },
            child: const Text('IMPORT'),
          ),
        ],
      ),
    );
  }
}

class _SongCard extends StatelessWidget {
  final Song song;
  const _SongCard({required this.song});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () {
        Navigator.push(
          context,
          MaterialPageRoute(builder: (_) => LyricEditorPage(song: song)),
        );
      },
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: AppTheme.cardBackground,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: Colors.white10),
        ),
        child: Row(
          children: [
            Container(
              width: 48,
              height: 48,
              decoration: BoxDecoration(
                color: AppTheme.technicalBorder,
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: Colors.white10),
              ),
              alignment: Alignment.center,
              child: const Text(
                'Em',
                style: TextStyle(
                  color: Colors.grey,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    song.title.toUpperCase(),
                    style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.bold,
                      fontSize: 16,
                    ),
                  ),
                  Text(
                    song.artist.toUpperCase(),
                    style: const TextStyle(
                      color: Colors.grey,
                      fontSize: 12,
                      letterSpacing: 1,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 6,
                      vertical: 2,
                    ),
                    decoration: BoxDecoration(
                      color: Colors.white10,
                      borderRadius: BorderRadius.circular(4),
                      border: Border.all(color: Colors.white10),
                    ),
                    child: Text(
                      '${song.bpm} BPM',
                      style: const TextStyle(
                        color: Colors.grey,
                        fontSize: 10,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Column(
              children: [
                IconButton(
                  onPressed: () {
                    Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (_) => StageViewPage(song: song),
                      ),
                    );
                  },
                  icon: const Icon(
                    Icons.play_circle_fill,
                    color: AppTheme.primaryColor,
                  ),
                  tooltip: 'Stage View',
                ),
                const Icon(
                  Icons.lyrics,
                  color: AppTheme.primaryColor,
                  size: 20,
                ),
                const Text(
                  'LRC',
                  style: TextStyle(
                    color: AppTheme.primaryColor,
                    fontSize: 8,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _NavIcon extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool isActive;
  final VoidCallback onTap; // Added onTap

  const _NavIcon({
    required this.icon,
    required this.label,
    required this.onTap, // Required now
    this.isActive = false,
  });

  @override
  Widget build(BuildContext context) {
    final color = isActive ? AppTheme.primaryColor : Colors.grey;
    return InkWell(
      onTap: onTap, // Handled here
      customBorder: const CircleBorder(),
      child: Padding(
        padding: const EdgeInsets.all(
          8.0,
        ), // increased padding for touch target
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          mainAxisSize: MainAxisSize.min, // prevent expansion
          children: [
            Icon(icon, color: color, size: 24),
            Text(
              label,
              style: TextStyle(
                color: color,
                fontSize: 10,
                fontWeight: FontWeight.bold,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
