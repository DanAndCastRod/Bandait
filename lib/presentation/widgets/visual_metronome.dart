import 'dart:async';
import 'package:flutter/material.dart';
import 'package:bandait/core/di/injection.dart';
import 'package:bandait/data/network/clock_service.dart';
import 'package:bandait/presentation/theme/app_theme.dart';

class VisualMetronome extends StatefulWidget {
  final Widget child;

  const VisualMetronome({super.key, required this.child});

  @override
  State<VisualMetronome> createState() => _VisualMetronomeState();
}

class _VisualMetronomeState extends State<VisualMetronome> {
  late final ClockService _clock;
  Color _borderColor = Colors.transparent;
  Timer? _flashTimer;

  @override
  void initState() {
    super.initState();
    _clock = getIt<ClockService>();
    _clock.beatStream.listen(_onBeat);
  }

  void _onBeat(int beatNb) {
    if (!mounted) return;

    // Beat 1: Strong Flash (White or User Color), Others: Weak
    final isDownbeat = beatNb == 1;

    setState(() {
      _borderColor = isDownbeat
          ? AppTheme.primaryColor.withOpacity(0.8)
          : AppTheme.primaryColor.withOpacity(0.3);
    });

    _flashTimer?.cancel();
    _flashTimer = Timer(const Duration(milliseconds: 100), () {
      if (mounted) {
        setState(() {
          _borderColor = Colors.transparent;
        });
      }
    });
  }

  @override
  void dispose() {
    _flashTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        border: Border.all(
          color: _borderColor,
          width: 8, // Thick border for visibility
        ),
      ),
      child: widget.child,
    );
  }
}
