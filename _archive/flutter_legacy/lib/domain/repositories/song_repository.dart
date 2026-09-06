import '../models/song.dart';

abstract interface class SongRepository {
  Future<void> initialize();
  Future<void> saveSong(Song song);
  Future<List<Song>> getSongs();
  Future<Song?> getSong(String id);
  Future<void> deleteSong(String id);
  Stream<List<Song>> watchSongs();
}
