import 'package:hive/hive.dart';
import 'package:injectable/injectable.dart';
import '../../domain/models/song.dart';
import '../../domain/repositories/song_repository.dart';

@LazySingleton(as: SongRepository)
class SongRepositoryImpl implements SongRepository {
  static const String boxName = 'songsBox';
  Box<Song>? _box;

  @override
  Future<void> initialize() async {
    if (_box == null || !_box!.isOpen) {
      _box = await Hive.openBox<Song>(boxName);
    }
  }

  @override
  Future<List<Song>> getSongs() async {
    await _ensureInitialized();
    return _box!.values.toList();
  }

  @override
  Future<Song?> getSong(String id) async {
    await _ensureInitialized();
    try {
      // Hive keys might be dynamic, but we store Song objects.
      // Searching by Internal ID (field) vs Hive Key.
      // Efficiency: If we use 'id' as Hive key it's O(1).
      // For now, let's scan or assume we save with 'id' as key.
      return _box!.get(id);
    } catch (e) {
      return null;
    }
  }

  @override
  Future<void> saveSong(Song song) async {
    await _ensureInitialized();
    await _box!.put(song.id, song);
  }

  @override
  Future<void> deleteSong(String id) async {
    await _ensureInitialized();
    await _box!.delete(id);
  }

  @override
  Stream<List<Song>> watchSongs() async* {
    await _ensureInitialized();
    yield _box!.values.toList();
    yield* _box!.watch().map((event) => _box!.values.toList());
  }

  Future<void> _ensureInitialized() async {
    if (_box == null || !_box!.isOpen) {
      await initialize();
    }
  }
}
