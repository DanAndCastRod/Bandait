import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mockito/mockito.dart';
import 'package:mockito/annotations.dart';
import 'package:bandait/core/di/injection.dart';
import 'package:bandait/domain/repositories/audio_engine.dart';
import 'package:bandait/presentation/pages/audio_settings/audio_settings_screen.dart';

// Create Mock
class MockAudioEngine extends Mock implements AudioEngine {
  @override
  Future<int> getGlobalOffset() async => 15;
  @override
  Future<int> getBufferLength() async => 256;
  @override
  Future<double> measureLatency() async => 42.0;

  // Stubs for void methods so they don't return null
  @override
  Future<void> setGlobalOffset(int? ms) async {}
  @override
  Future<void> setBufferLength(int? samples) async {}
  @override
  Future<void> initialize() async {}
  @override
  Future<void> dispose() async {}
  @override
  void playTick() {}
  @override
  void playTock() {}
}

void main() {
  late MockAudioEngine mockAudioEngine;

  setUp(() async {
    mockAudioEngine = MockAudioEngine();
    await getIt.reset();
    getIt.registerSingleton<AudioEngine>(mockAudioEngine);
  });

  testWidgets('AudioSettingsScreen loads and displays properties', (
    tester,
  ) async {
    // pump the widget
    await tester.pumpWidget(const MaterialApp(home: AudioSettingsScreen()));

    // Initial state loading
    await tester.pumpAndSettle();

    debugDumpApp();

    // Verify Title
    expect(find.text('AUDIO ENGINE'), findsOneWidget);

    // Verify Stats (Mocked values)
    expect(find.text('12.4 MS'), findsOneWidget); // Initial hardcoded in State
    // Wait, let's trigger the latency test to see if it updates

    // Find "INITIATE PING" button
    final fab = find.text('INITIATE PING');
    expect(fab, findsOneWidget);

    await tester.tap(fab);
    await tester.pump(const Duration(milliseconds: 600)); // Wait for fake delay

    // Verify updated latency from Mock
    expect(find.text('42.0 MS'), findsOneWidget);
  });
}
