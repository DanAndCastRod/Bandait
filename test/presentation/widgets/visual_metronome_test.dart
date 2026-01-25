import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:bandait/presentation/widgets/visual_metronome.dart';
import 'package:bandait/core/di/injection.dart';
import 'package:mockito/mockito.dart';
import 'package:bandait/data/network/clock_service.dart';
import '../test_helpers.mocks.dart';

void main() {
  late MockClockService mockClock;
  late StreamController<int> beatController;

  setUp(() {
    mockClock = MockClockService();
    beatController = StreamController<int>.broadcast();

    // Stub the beatStream usage
    when(mockClock.beatStream).thenAnswer((_) => beatController.stream);

    getIt.reset();
    getIt.registerSingleton<ClockService>(mockClock);
  });

  tearDown(() {
    getIt.reset();
    beatController.close();
  });

  testWidgets('VisualMetronome renders child content and listens to stream', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(home: VisualMetronome(child: Text('I am the content'))),
    );

    // Initial render
    expect(find.text('I am the content'), findsOneWidget);

    // Trigger beat 1 (Strong flash)
    beatController.add(1);
    await tester.pump(); // Update state

    // Allow timer to complete (100ms in widget code)
    await tester.pump(const Duration(milliseconds: 150));

    // Confirm child still visible.
    expect(find.text('I am the content'), findsOneWidget);
  });
}
