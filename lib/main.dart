import 'package:flutter/material.dart';
import 'src/data/repositories/mock_sync_repository.dart';
import 'src/presentation/debug/debug_screen.dart';

void main() {
  // Dependency Injection would go here.
  // For now, we manually inject the mock repository.
  final syncRepository = MockSyncRepository();

  runApp(BandaitApp(repository: syncRepository));
}

class BandaitApp extends StatelessWidget {
  final MockSyncRepository repository;

  const BandaitApp({super.key, required this.repository});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Bandait Debug',
      theme: ThemeData.dark().copyWith(
        scaffoldBackgroundColor: Colors.black,
        colorScheme: const ColorScheme.dark(
          primary: Colors.white,
          secondary: Colors.blueAccent,
        ),
      ),
      home: DebugScreen(repository: repository),
    );
  }
}
