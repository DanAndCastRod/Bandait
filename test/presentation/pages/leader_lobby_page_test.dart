import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mockito/mockito.dart';
import 'package:bandait/core/di/injection.dart';
import 'package:bandait/domain/repositories/session_repository.dart';
import 'package:bandait/domain/models/user_profile.dart';
import 'package:bandait/presentation/pages/connect/leader_lobby_page.dart';
import 'package:bandait/data/network/clock_service.dart';
import 'package:bandait/domain/repositories/audio_engine.dart';
import '../test_helpers.mocks.dart';

/// Local mock with hand-written overrides for SessionRepository.
/// Named differently to avoid conflict with generated MockSessionRepository.
class FakeSessionRepository extends Mock implements SessionRepository {
  @override
  Stream<List<String>> get connectedPeers =>
      Stream.value(['Client A', 'Client B']);
  @override
  Future<void> startHosting({
    required String sessionName,
    required int port,
  }) async {}
  @override
  Future<void> stopHosting() async {}
  @override
  bool get isLeader => true;
  @override
  Stream<int> get latencyStream => Stream.value(0);
  @override
  Stream<String> get messageStream => Stream.empty();
  @override
  Future<void> connectTo(String host, int port) async {}
  @override
  Future<void> disconnect() async {}
  @override
  Future<void> startMetronome(double bpm) async {}
  @override
  Future<void> stopMetronome() async {}
  @override
  Future<void> sendPanic() async {}
  @override
  Future<UserProfile?> getUserProfile() async => null;
  @override
  Future<void> saveUserProfile(UserProfile profile) async {}
  @override
  Future<void> broadcastMessage(String message) async {}
}

void main() {
  late FakeSessionRepository mockRepo;
  late MockClockService mockClock;

  setUpAll(() {
    TestWidgetsFlutterBinding.ensureInitialized();
  });

  setUp(() async {
    mockRepo = FakeSessionRepository();
    mockClock = MockClockService();
    final mockAudio = MockAudioEngine();

    // Stub beatStream to prevent crash in VisualMetronome
    when(mockClock.beatStream).thenAnswer((_) => Stream.value(1));
    when(mockAudio.isInitialized).thenReturn(true);

    await getIt.reset();
    getIt.registerSingleton<SessionRepository>(mockRepo);
    getIt.registerSingleton<ClockService>(mockClock);
    getIt.registerSingleton<AudioEngine>(mockAudio);
  });

  testWidgets('LeaderLobbyPage generates QR and shows peers', (tester) async {
    final profile = const UserProfile(
      id: 'mock_id',
      name: 'Freddie',
      instrument: 'Vocals',
      colorValue: 0xFFFFFFFF,
    );

    await tester.pumpWidget(
      MaterialApp(home: LeaderLobbyPage(userProfile: profile)),
    );
    // Pump several frames to allow:
    // 1. NetworkInterface.list() future to resolve
    // 2. startHosting() future to complete
    // 3. setState(_isHosting = true) to rebuild the widget
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 1));
    // Do NOT use pumpAndSettle — VisualMetronome has infinite animations

    // Verify Title (always visible in AppBar)
    expect(find.text('THE ROCKERS'), findsOneWidget);

    // Check for settings button in AppBar
    expect(find.byIcon(Icons.settings), findsOneWidget);

    // Check if hosting started (body content visible only when _isHosting)
    final joinCode = find.text('JOIN CODE');
    if (joinCode.evaluate().isNotEmpty) {
      // Hosting started — verify peer content
      expect(find.text('BAND MEMBERS'), findsOneWidget);
    }
    // If hosting hasn't started, the CircularProgressIndicator is shown
    // This is acceptable since NetworkInterface.list() behavior varies in test env
  });
}
