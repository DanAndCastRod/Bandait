import '../models/setlist.dart';

abstract class SetlistRepository {
  Future<void> initialize();
  Stream<List<Setlist>> watchSetlists();
  Future<void> saveSetlist(Setlist setlist);
  Future<void> deleteSetlist(String id);
}
