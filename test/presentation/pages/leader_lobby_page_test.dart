import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mockito/mockito.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import 'package:bandait/core/di/injection.dart';
import 'package:bandait/domain/repositories/session_repository.dart';
import 'package:bandait/domain/models/user_profile.dart';
import 'package:bandait/presentation/pages/connect/leader_lobby_page.dart';
import 'package:bandait/data/network/clock_service.dart';
import '../test_helpers.mocks.dart';

class MockSessionRepository extends Mock implements SessionRepository {
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
  late MockSessionRepository mockRepo;
  late MockClockService mockClock;

  setUpAll(() {
    TestWidgetsFlutterBinding.ensureInitialized();
  });

  setUp(() {
    mockRepo = MockSessionRepository();
    mockClock = MockClockService();

    // Stub beatStream to prevent crash in VisualMetronome
    when(mockClock.beatStream).thenAnswer((_) => Stream.value(1));

    getIt.reset();
    getIt.registerSingleton<SessionRepository>(mockRepo);
    getIt.registerSingleton<ClockService>(mockClock);
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
    await tester.pumpAndSettle();

    // Verify Title
    expect(find.text('BAND LEADER'), findsOneWidget);

    // Verify QR Code container exists
    expect(find.text('SCAN TO JOIN'), findsOneWidget);

    // Verify Connected Peers from Stream
    expect(find.text('Freddie'), findsOneWidget); // Host self-card

    // START METRONOME should be present (wrapped in column)
    expect(find.text('START'), findsOneWidget);

    // Check for Exit button in AppBar
    expect(find.byIcon(Icons.exit_to_app), findsOneWidget);
  });
}
