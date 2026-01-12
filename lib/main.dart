import 'package:flutter/material.dart';
import 'package:bandait/injection.dart';

void main() {
  configureDependencies();
  runApp(const BandaitApp());
}

class BandaitApp extends StatelessWidget {
  const BandaitApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Bandait',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.deepPurple),
        useMaterial3: true,
      ),
      home: const Scaffold(
        body: Center(
          child: Text('Bandait App Initialized'),
        ),
      ),
    );
  }
}
