import 'package:hive_flutter/hive_flutter.dart';
import 'package:injectable/injectable.dart';
import '../../domain/models/setlist.dart';
import '../../domain/repositories/setlist_repository.dart';

@LazySingleton(as: SetlistRepository)
class SetlistRepositoryImpl implements SetlistRepository {
  static const String _boxName = 'setlists';
  Box<Setlist>? _box;

  @override
  Future<void> initialize() async {
    if (!Hive.isAdapterRegistered(3)) {
      Hive.registerAdapter(SetlistImplAdapter());
    }
    _box = await Hive.openBox<Setlist>(_boxName);
  }

  @override
  Stream<List<Setlist>> watchSetlists() {
    if (_box == null) throw Exception('SetlistRepository not initialized');
    // Emit initial value
    final initial = _box!.values.toList();
    // Use proper stream transformation
    return _box!.watch().map((_) => _box!.values.toList()).startWith(initial);
  }

  @override
  Future<void> saveSetlist(Setlist setlist) async {
    if (_box == null) throw Exception('SetlistRepository not initialized');
    await _box!.put(setlist.id, setlist);
  }

  @override
  Future<void> deleteSetlist(String id) async {
    if (_box == null) throw Exception('SetlistRepository not initialized');
    await _box!.delete(id);
  }
}

extension StreamStartWith<T> on Stream<T> {
  Stream<T> startWith(T initial) async* {
    yield initial;
    yield* this;
  }
}
