import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:hive/hive.dart';
import 'package:bandait/domain/models/song.dart';
import 'package:bandait/data/repositories/song_repository_impl.dart';

void main() {
  group('SongRepository CRUD', () {
    late Directory tempDir;
    late SongRepositoryImpl repository;

    setUp(() async {
      tempDir = await Directory.systemTemp.createTemp('hive_test_song');
      Hive.init(tempDir.path);

      if (!Hive.isAdapterRegistered(1)) {
        Hive.registerAdapter(SongImplAdapter());
      }
      if (!Hive.isAdapterRegistered(2)) {
        Hive.registerAdapter(LyricLineImplAdapter());
      }

      repository = SongRepositoryImpl();
    });

    tearDown(() async {
      await Hive.close();
      await tempDir.delete(recursive: true);
    });

    test('getSongs returns empty initially', () async {
      await repository.initialize();
      final songs = await repository.getSongs();
      expect(songs, isEmpty);
    });

    test('saveSong adds a song', () async {
      final song = Song(id: '1', title: 'Test Song', bpm: 120);
      await repository.saveSong(song);

      final songs = await repository.getSongs();
      expect(songs.length, 1);
      expect(songs.first.title, 'Test Song');
    });

    test('getSong returns correct song', () async {
      final song = Song(id: '1', title: 'Found Me', bpm: 100);
      await repository.saveSong(song);

      final retrieved = await repository.getSong('1');
      expect(retrieved, isNotNull);
      expect(retrieved!.title, 'Found Me');
    });

    test('deleteSong removes item', () async {
      final song = Song(id: 'del', title: 'Delete Me');
      await repository.saveSong(song);

      await repository.deleteSong('del');
      final songs = await repository.getSongs();
      expect(songs, isEmpty);
    });
  });
}
