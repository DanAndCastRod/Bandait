import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mockito/mockito.dart';
import 'package:bandait/core/di/injection.dart';
import 'package:bandait/domain/repositories/song_repository.dart';
import 'package:bandait/domain/models/song.dart';
import 'package:bandait/presentation/pages/library/song_library_page.dart';

class MockSongRepository extends Mock implements SongRepository {
  @override
  Future<void> initialize() async {}
  @override
  Future<List<Song>> getSongs() async => [];
  @override
  Future<Song?> getSong(String id) async => null;
  @override
  Future<void> saveSong(Song song) async {}
  @override
  Future<void> deleteSong(String id) async {}

  @override
  Stream<List<Song>> watchSongs() {
    return Stream.value([
      const Song(id: '1', title: 'Bohemian Rhapsody', artist: 'Queen', bpm: 72),
      const Song(
        id: '2',
        title: 'Stairway to Heaven',
        artist: 'Led Zeppelin',
        bpm: 82,
      ),
    ]);
  }
}

void main() {
  late MockSongRepository mockRepo;

  setUp(() async {
    mockRepo = MockSongRepository();
    await getIt.reset();
    getIt.registerSingleton<SongRepository>(mockRepo);
  });

  testWidgets('SongLibraryPage displays list of songs', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: SongLibraryPage()));
    await tester.pumpAndSettle();

    expect(find.text('SONG LIBRARY'), findsOneWidget);
    expect(find.text('Bohemian Rhapsody'), findsOneWidget);
    expect(find.text('Led Zeppelin'), findsOneWidget);

    // Test Interaction: Tap on item (should navigate or show details)
    // For now just confirming presence is enough for UI check.
  });
}
