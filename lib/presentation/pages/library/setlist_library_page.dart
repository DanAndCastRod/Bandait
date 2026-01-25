import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../../core/di/injection.dart';
import '../../../domain/models/setlist.dart';
import '../../../domain/repositories/setlist_repository.dart';
import '../../theme/app_theme.dart';
import 'setlist_editor_page.dart'; // Added Import

class SetlistLibraryPage extends StatefulWidget {
  const SetlistLibraryPage({super.key});

  @override
  State<SetlistLibraryPage> createState() => _SetlistLibraryPageState();
}

class _SetlistLibraryPageState extends State<SetlistLibraryPage> {
  final SetlistRepository _repository = getIt<SetlistRepository>();
  bool _isInitialized = false;

  @override
  void initState() {
    super.initState();
    _initRepo();
  }

  Future<void> _initRepo() async {
    try {
      if (!mounted) return;
      await _repository.initialize();
      if (mounted) setState(() => _isInitialized = true);
    } catch (e, stack) {
      debugPrint('Error initializing SetlistRepo: $e');
      if (mounted) {
        showDialog(
          context: context,
          builder: (context) => AlertDialog(
            title: const Text(
              'Initialization Error',
              style: TextStyle(color: Colors.red),
            ),
            content: Text('Failed to load setlists:\n$e'),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('OK'),
              ),
            ],
          ),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_isInitialized) {
      return const Scaffold(
        backgroundColor: AppTheme.darkBackground,
        body: Center(
          child: CircularProgressIndicator(color: AppTheme.primaryColor),
        ),
      );
    }

    return Scaffold(
      backgroundColor: AppTheme.darkBackground,
      appBar: AppBar(
        title: const Text(
          'SETLISTS',
          style: TextStyle(
            fontFamily: 'Space Grotesk',
            fontWeight: FontWeight.bold,
            letterSpacing: 1.5,
          ),
        ),
        backgroundColor: AppTheme.cardBackground,
      ),
      body: StreamBuilder<List<Setlist>>(
        stream: _repository.watchSetlists(),
        builder: (context, snapshot) {
          if (!snapshot.hasData)
            return const Center(
              child: CircularProgressIndicator(color: AppTheme.primaryColor),
            );
          final setlists = snapshot.data!;

          if (setlists.isEmpty) {
            return Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(Icons.playlist_play, size: 64, color: Colors.grey[800]),
                  const SizedBox(height: 16),
                  Text(
                    'NO SETLISTS',
                    style: TextStyle(color: Colors.grey[600], letterSpacing: 2),
                  ),
                ],
              ),
            );
          }

          return ListView.separated(
            padding: const EdgeInsets.all(16),
            itemCount: setlists.length,
            separatorBuilder: (_, __) => const SizedBox(height: 12),
            itemBuilder: (context, index) {
              final setlist = setlists[index];
              return _SetlistCard(setlist: setlist);
            },
          );
        },
      ),
      floatingActionButton: FloatingActionButton(
        backgroundColor: AppTheme.primaryColor,
        child: const Icon(Icons.add, color: Colors.black),
        onPressed: () {
          final newSet = Setlist(
            id: DateTime.now().millisecondsSinceEpoch.toString(),
            title: 'New Setlist ${DateFormat('MM/dd').format(DateTime.now())}',
            createdDate: DateTime.now(),
          );

          Navigator.push(
            context,
            MaterialPageRoute(
              builder: (_) => SetlistEditorPage(setlist: newSet, isNew: true),
            ),
          );
        },
      ),
    );
  }
}

class _SetlistCard extends StatelessWidget {
  final Setlist setlist;
  const _SetlistCard({required this.setlist});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () {
        Navigator.push(
          context,
          MaterialPageRoute(
            builder: (_) => SetlistEditorPage(setlist: setlist),
          ),
        );
      },
      child: Container(
        padding: const EdgeInsets.all(16),
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
                borderRadius: BorderRadius.circular(4),
              ),
              child: const Icon(Icons.list, color: AppTheme.primaryColor),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    setlist.title.toUpperCase(),
                    style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.bold,
                      fontSize: 16,
                    ),
                  ),
                  Text(
                    '${setlist.songIds.length} TRACKS • ${DateFormat('MMM dd').format(setlist.createdDate)}',
                    style: TextStyle(color: Colors.grey[600], fontSize: 12),
                  ),
                ],
              ),
            ),
            IconButton(
              icon: const Icon(Icons.edit, color: Colors.grey),
              onPressed: () {
                Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (_) => SetlistEditorPage(setlist: setlist),
                  ),
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}
