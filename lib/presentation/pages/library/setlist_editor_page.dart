import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../../core/di/injection.dart';
import '../../../domain/models/setlist.dart';
import '../../../domain/models/song.dart';
import '../../../domain/repositories/setlist_repository.dart';
import '../../../domain/repositories/song_repository.dart';
import '../../theme/app_theme.dart';

class SetlistEditorPage extends StatefulWidget {
  final Setlist setlist;
  final bool isNew;

  const SetlistEditorPage({
    super.key,
    required this.setlist,
    this.isNew = false,
  });

  @override
  State<SetlistEditorPage> createState() => _SetlistEditorPageState();
}

class _SetlistEditorPageState extends State<SetlistEditorPage> {
  final _setlistRepo = getIt<SetlistRepository>();
  final _songRepo = getIt<SongRepository>();

  late TextEditingController _titleController;
  late List<String> _songIds;

  // Cache for display
  Map<String, Song> _songCache = {};
  bool _isLoading = true;
  bool _isDirty = false;

  @override
  void initState() {
    super.initState();
    _titleController = TextEditingController(text: widget.setlist.title);
    _songIds = List.from(widget.setlist.songIds);
    _loadSongs();
  }

  Future<void> _loadSongs() async {
    final allSongs = await _songRepo.watchSongs().first; // Get current snapshot
    _songCache = {for (var s in allSongs) s.id: s};
    if (mounted) setState(() => _isLoading = false);
  }

  void _save() async {
    final updatedSetlist = widget.setlist.copyWith(
      title: _titleController.text,
      songIds: _songIds,
    );
    await _setlistRepo.saveSetlist(updatedSetlist);
    if (mounted) Navigator.pop(context);
  }

  void _showAddSongDialog() async {
    final allSongs = await _songRepo.watchSongs().first;

    if (!mounted) return;

    showModalBottomSheet(
      context: context,
      backgroundColor: AppTheme.cardBackground,
      isScrollControlled: true,
      builder: (context) => DraggableScrollableSheet(
        initialChildSize: 0.7,
        maxChildSize: 0.9,
        minChildSize: 0.5,
        builder: (_, controller) => Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(
                'ADD SONGS',
                style: const TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.bold,
                  letterSpacing: 2,
                ),
              ),
            ),
            Expanded(
              child: ListView.separated(
                controller: controller,
                itemCount: allSongs.length,
                separatorBuilder: (_, __) =>
                    const Divider(color: Colors.white10),
                itemBuilder: (_, index) {
                  final song = allSongs[index];
                  final isAdded = _songIds.contains(song.id);
                  return ListTile(
                    title: Text(
                      song.title,
                      style: const TextStyle(color: Colors.white),
                    ),
                    subtitle: Text(
                      song.artist,
                      style: TextStyle(color: Colors.grey[600]),
                    ),
                    trailing: isAdded
                        ? const Icon(
                            Icons.check_circle,
                            color: AppTheme.primaryColor,
                          )
                        : const Icon(
                            Icons.add_circle_outline,
                            color: Colors.grey,
                          ),
                    onTap: () {
                      setState(() {
                        if (!isAdded) {
                          _songIds.add(song.id);
                          _isDirty = true;
                        }
                      });
                      Navigator.pop(context);
                    },
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return WillPopScope(
      onWillPop: () async {
        if (_isDirty) {
          // TODO: Confirm discard
        }
        return true;
      },
      child: Scaffold(
        backgroundColor: AppTheme.darkBackground,
        appBar: AppBar(
          backgroundColor: AppTheme.cardBackground,
          title: TextField(
            controller: _titleController,
            style: const TextStyle(
              color: Colors.white,
              fontWeight: FontWeight.bold,
              fontSize: 20,
            ),
            decoration: const InputDecoration(
              border: InputBorder.none,
              hintText: 'Setlist Name',
              hintStyle: TextStyle(color: Colors.white24),
            ),
            onChanged: (_) => setState(() => _isDirty = true),
          ),
          actions: [
            TextButton.icon(
              onPressed: _isDirty ? _save : null,
              icon: Icon(
                Icons.save,
                color: _isDirty ? AppTheme.primaryColor : Colors.grey,
              ),
              label: Text(
                'SAVE',
                style: TextStyle(
                  color: _isDirty ? AppTheme.primaryColor : Colors.grey,
                ),
              ),
            ),
          ],
        ),
        body: _isLoading
            ? const Center(
                child: CircularProgressIndicator(color: AppTheme.primaryColor),
              )
            : ReorderableListView.builder(
                padding: const EdgeInsets.only(bottom: 80),
                itemCount: _songIds.length,
                onReorder: (oldIndex, newIndex) {
                  setState(() {
                    if (oldIndex < newIndex) {
                      newIndex -= 1;
                    }
                    final item = _songIds.removeAt(oldIndex);
                    _songIds.insert(newIndex, item);
                    _isDirty = true;
                  });
                },
                itemBuilder: (context, index) {
                  final songId = _songIds[index];
                  final song = _songCache[songId];
                  return _SetlistItem(
                    key: ValueKey(songId),
                    index: index,
                    song: song,
                    onRemove: () {
                      setState(() {
                        _songIds.removeAt(index);
                        _isDirty = true;
                      });
                    },
                  );
                },
              ),
        floatingActionButton: FloatingActionButton.extended(
          backgroundColor: AppTheme.primaryColor,
          onPressed: _showAddSongDialog,
          icon: const Icon(Icons.add, color: Colors.black),
          label: const Text(
            'ADD SONG',
            style: TextStyle(color: Colors.black, fontWeight: FontWeight.bold),
          ),
        ),
      ),
    );
  }
}

class _SetlistItem extends StatelessWidget {
  final int index;
  final Song? song;
  final VoidCallback onRemove;

  const _SetlistItem({
    super.key,
    required this.index,
    required this.song,
    required this.onRemove,
  });

  @override
  Widget build(BuildContext context) {
    if (song == null) return const SizedBox.shrink(); // Deleted song?

    return Container(
      margin: const EdgeInsets.symmetric(vertical: 2, horizontal: 8),
      decoration: BoxDecoration(
        color: AppTheme.cardBackground,
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: Colors.white10),
      ),
      child: ListTile(
        leading: Container(
          width: 32,
          height: 32,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: Colors.white10,
            shape: BoxShape.circle,
          ),
          child: Text(
            '${index + 1}',
            style: const TextStyle(
              color: Colors.white,
              fontWeight: FontWeight.bold,
            ),
          ),
        ),
        title: Text(song!.title, style: const TextStyle(color: Colors.white)),
        subtitle: Text(
          '${song!.artist} • ${song!.bpm} BPM',
          style: TextStyle(color: Colors.grey[600]),
        ),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            IconButton(
              icon: const Icon(Icons.remove_circle, color: Colors.redAccent),
              onPressed: onRemove,
            ),
            const Icon(Icons.drag_handle, color: Colors.grey),
          ],
        ),
      ),
    );
  }
}
