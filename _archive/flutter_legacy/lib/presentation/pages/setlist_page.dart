import 'package:flutter/material.dart';
import '../../core/di/injection.dart';
import '../../domain/repositories/song_repository.dart';
import '../../domain/models/song.dart';
import '../../data/services/lrc_parser.dart';

class SetlistPage extends StatefulWidget {
  const SetlistPage({super.key});

  @override
  State<SetlistPage> createState() => _SetlistPageState();
}

class _SetlistPageState extends State<SetlistPage> {
  late final SongRepository _repository;
  late final LrcParser _parser;

  @override
  void initState() {
    super.initState();
    _repository = getIt<SongRepository>();
    _parser = getIt<LrcParser>();
  }

  void _showAddSongDialog() {
    final textController = TextEditingController();
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Add Song (Paste LRC)'),
        content: TextField(
          controller: textController,
          maxLines: 10,
          decoration: const InputDecoration(
            hintText: '[00:00.00] Lyrics...\n#TAG:Value',
            border: OutlineInputBorder(),
          ),
          style: const TextStyle(fontFamily: 'monospace'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () async {
              final content = textController.text;
              if (content.isNotEmpty) {
                try {
                  final song = _parser.parse(content);
                  await _repository.saveSong(song);
                  if (context.mounted) Navigator.pop(context);
                } catch (e) {
                  ScaffoldMessenger.of(
                    context,
                  ).showSnackBar(SnackBar(content: Text('Error parsing: $e')));
                }
              }
            },
            child: const Text('Save'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Setlist')),
      floatingActionButton: FloatingActionButton(
        onPressed: _showAddSongDialog,
        child: const Icon(Icons.add),
      ),
      body: StreamBuilder<List<Song>>(
        stream: _repository.watchSongs(),
        builder: (context, snapshot) {
          if (snapshot.hasError) {
            return Center(child: Text('Error: ${snapshot.error}'));
          }
          if (!snapshot.hasData) {
            return const Center(child: CircularProgressIndicator());
          }

          final songs = snapshot.data!;
          if (songs.isEmpty) {
            return const Center(child: Text('No songs yet. Add one!'));
          }

          return ListView.builder(
            itemCount: songs.length,
            itemBuilder: (context, index) {
              final song = songs[index];
              return ListTile(
                leading: const Icon(Icons.music_note, color: Colors.teal),
                title: Text(
                  song.title,
                  style: const TextStyle(fontWeight: FontWeight.bold),
                ),
                subtitle: Text('${song.bpm} BPM | ${song.signature}'),
                trailing: IconButton(
                  icon: const Icon(Icons.delete, color: Colors.red),
                  onPressed: () => _repository.deleteSong(song.id),
                ),
                onTap: () {
                  // TODO: Navigate to Song Detail/Play
                },
              );
            },
          );
        },
      ),
    );
  }
}
