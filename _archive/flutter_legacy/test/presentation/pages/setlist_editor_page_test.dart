import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mockito/mockito.dart';
import 'package:bandait/core/di/injection.dart';
import 'package:bandait/domain/models/setlist.dart';
import 'package:bandait/domain/models/song.dart';
import 'package:bandait/domain/repositories/setlist_repository.dart';
import 'package:bandait/domain/repositories/song_repository.dart';
import 'package:bandait/presentation/pages/library/setlist_editor_page.dart';

class FakeSetlistRepository extends Mock implements SetlistRepository {
  @override
  Future<void> initialize() async {}
  @override
  Future<List<Setlist>> getSetlists() async => [];
  @override
  Future<Setlist?> getSetlist(String id) async => null;
  @override
  Future<void> saveSetlist(Setlist setlist) async {}
  @override
  Future<void> deleteSetlist(String id) async {}
  @override
  Stream<List<Setlist>> watchSetlists() => Stream.value([]);
}

class FakeSongRepository extends Mock implements SongRepository {
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
      const Song(id: '1', title: 'Song 1', artist: 'Artist 1', bpm: 120),
    ]);
  }
}

void main() {
  late FakeSetlistRepository mockSetlistRepo;
  late FakeSongRepository mockSongRepo;

  setUp(() async {
    mockSetlistRepo = FakeSetlistRepository();
    mockSongRepo = FakeSongRepository();
    await getIt.reset();
    getIt.registerSingleton<SetlistRepository>(mockSetlistRepo);
    getIt.registerSingleton<SongRepository>(mockSongRepo);
  });

  testWidgets('SetlistEditorPage shows discard dialog when dirty and popped',
      (tester) async {
    final setlist = Setlist(
      id: 's1',
      title: 'Original Title',
      songIds: const ['1'],
      createdDate: DateTime.now(),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () {
                Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (_) => SetlistEditorPage(setlist: setlist),
                  ),
                );
              },
              child: const Text('OPEN EDITOR'),
            ),
          ),
        ),
      ),
    );

    // Open editor
    await tester.tap(find.text('OPEN EDITOR'));
    await tester.pumpAndSettle();

    expect(find.text('Original Title'), findsOneWidget);

    // Modify text to mark as dirty
    await tester.enterText(find.byType(TextField).first, 'New Title');
    await tester.pump();

    // Try popping the route
    final dynamic pageState = tester.state(find.byType(SetlistEditorPage));
    final NavigatorState navigator = Navigator.of(pageState.context);
    navigator.maybePop();
    await tester.pumpAndSettle();

    // Confirm dialog is shown
    expect(find.text('Discard Changes?'), findsOneWidget);
    expect(
      find.text('You have unsaved changes. Are you sure you want to discard them?'),
      findsOneWidget,
    );

    // Tap CANCEL
    await tester.tap(find.text('CANCEL'));
    await tester.pumpAndSettle();

    // Verify dialog closed and still on SetlistEditorPage
    expect(find.text('Discard Changes?'), findsNothing);
    expect(find.byType(SetlistEditorPage), findsOneWidget);

    // Try popping again
    navigator.maybePop();
    await tester.pumpAndSettle();

    // Tap DISCARD
    await tester.tap(find.text('DISCARD'));
    await tester.pumpAndSettle();

    // Verify popped back to main page
    expect(find.byType(SetlistEditorPage), findsNothing);
    expect(find.text('OPEN EDITOR'), findsOneWidget);
  });
}
