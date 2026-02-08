import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';
import 'package:mocktail/mocktail.dart';
import 'package:bandait/domain/repositories/session_repository.dart';
import 'package:bandait/presentation/pages/profile_selection_page.dart';
import 'package:bandait/presentation/theme/app_theme.dart';

class MockSessionRepository extends Mock implements SessionRepository {}

void main() {
  final getIt = GetIt.instance;
  late MockSessionRepository mockSessionRepo;

  setUp(() {
    mockSessionRepo = MockSessionRepository();
    // Register the mock
    if (getIt.isRegistered<SessionRepository>()) {
      getIt.unregister<SessionRepository>();
    }
    getIt.registerSingleton<SessionRepository>(mockSessionRepo);
  });

  tearDown(() {
    getIt.reset();
  });

  testWidgets('ProfileSelectionPage load smoke test', (
    WidgetTester tester,
  ) async {
    // Arrange
    when(() => mockSessionRepo.getUserProfile()).thenAnswer((_) async => null);

    // Act
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.darkTheme,
        home: const ProfileSelectionPage(),
      ),
    );
    await tester.pump(); // Allow FutureBuilder/initState to complete

    // Assert
    expect(find.text('BANDAIT IDENTITY'), findsOneWidget);
    expect(find.text('YOUR NAME'), findsOneWidget);
    expect(find.text('INSTRUMENT'), findsOneWidget);
  });
}
