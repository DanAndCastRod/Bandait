import 'dart:async';
import 'package:flutter/material.dart';
import '../../core/di/injection.dart';
import '../../domain/models/sync_result.dart';
import '../../domain/repositories/sync_service.dart';
import '../../domain/repositories/server_engine.dart';
import '../../domain/repositories/audio_engine.dart';
import '../../domain/models/message_model.dart';
import '../../domain/enums/message_type.dart';

class DebugSyncPage extends StatefulWidget {
  final bool isLeader;
  const DebugSyncPage({super.key, this.isLeader = false});

  @override
  State<DebugSyncPage> createState() => _DebugSyncPageState();
}

class _DebugSyncPageState extends State<DebugSyncPage> {
  late final SyncService _syncService;
  late final AudioEngine _audioEngine;
  StreamSubscription<SyncResult>? _subscription;

  SyncResult? _lastResult;
  bool _isSyncing = false;

  @override
  void initState() {
    super.initState();
    _syncService = getIt<SyncService>();
    _audioEngine = getIt<AudioEngine>();

    // Initialize audio for debug
    _audioEngine.initialize();

    _subscription = _syncService.onSyncUpdate.listen((result) {
      setState(() {
        _lastResult = result;
      });
    });

    _syncService.onFlashCommand.listen((triggerTime) {
      _scheduleFlash(triggerTime);
    });
  }

  // ... (dispose and toggleSync)

  void _scheduleFlash(int triggerTime) async {
    // Calculate time until flash using corrected time
    final delay = triggerTime - _syncService.correctedTimeMs;

    if (delay > 0) {
      await Future.delayed(Duration(milliseconds: delay));
      if (mounted) {
        _performFlashEffect();
      }
    } else {
      // Too late!
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('MISSED FLASH by ${delay.abs()}ms'),
          backgroundColor: Colors.red,
        ),
      );
    }
  }

  void _performFlashEffect() {
    // Audio Flash
    _audioEngine.playTick();

    // Visual flash logic
    showDialog(
      context: context,
      barrierDismissible: false,
      barrierColor: Colors.white, // FLASH!
      builder: (_) => const SizedBox(),
    );
    Future.delayed(const Duration(milliseconds: 100), () {
      if (mounted && Navigator.canPop(context)) Navigator.pop(context);
    });
  }

  @override
  void dispose() {
    _subscription?.cancel();
    _syncService.stopPeriodicSync();
    super.dispose();
  }

  void _toggleSync() {
    setState(() {
      _isSyncing = !_isSyncing;
    });
    if (_isSyncing) {
      _syncService.startPeriodicSync();
    } else {
      _syncService.stopPeriodicSync();
    }
  }

  void _flashTest() async {
    if (widget.isLeader) {
      // Schedule a flash 2 seconds in the future
      final futureTime = DateTime.now().millisecondsSinceEpoch + 2000;

      final message = MessageModel(
        type: MessageType.flash,
        payload: {'triggerTime': futureTime},
        timestamp: DateTime.now().millisecondsSinceEpoch,
      );

      final server = getIt<ServerEngine>();
      server.broadcast(message.toJson());

      // Schedule local flash too
      _scheduleFlash(futureTime);

      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Broadcasting Flash Command...'),
          backgroundColor: Colors.blue,
          duration: Duration(milliseconds: 500),
        ),
      );
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Only Leader can trigger Flash'),
          backgroundColor: Colors.grey,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: const Text('Sync Debug'),
        backgroundColor: Colors.grey[900],
      ),
      body: Padding(
        padding: const EdgeInsets.all(24.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _buildMetricCard(
              'OFFSET',
              '${_syncService.currentOffsetMs} ms',
              _getOffsetColor(_syncService.currentOffsetMs),
            ),
            const SizedBox(height: 16),
            _buildMetricCard(
              'RTT',
              '${_syncService.currentRttMs} ms',
              _getRttColor(_syncService.currentRttMs),
            ),
            const SizedBox(height: 16),
            _buildMetricCard(
              'JITTER',
              '${_syncService.jitterMs} ms',
              _getJitterColor(_syncService.jitterMs),
            ),
            const SizedBox(height: 16),
            _buildMetricCard(
              'STATUS',
              _lastResult?.isValid == true ? 'VALID' : 'WAITING',
              _lastResult?.isValid == true ? Colors.green : Colors.orange,
            ),
            const Spacer(),
            ElevatedButton(
              onPressed: _toggleSync,
              style: ElevatedButton.styleFrom(
                backgroundColor: _isSyncing ? Colors.red : Colors.green,
                padding: const EdgeInsets.symmetric(vertical: 20),
              ),
              child: Text(
                _isSyncing ? 'STOP SYNC' : 'START SYNC',
                style: const TextStyle(
                  fontSize: 24,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ),
            const SizedBox(height: 16),
            ElevatedButton(
              onPressed: _isSyncing ? _flashTest : null,
              style: ElevatedButton.styleFrom(
                backgroundColor: Colors.amber,
                padding: const EdgeInsets.symmetric(vertical: 20),
              ),
              child: const Text(
                '⚡ FLASH TEST',
                style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildMetricCard(String label, String value, Color color) {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        border: Border.all(color: color, width: 2),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            label,
            style: TextStyle(
              color: Colors.grey[400],
              fontSize: 18,
              fontWeight: FontWeight.w500,
            ),
          ),
          Text(
            value,
            style: TextStyle(
              color: color,
              fontSize: 32,
              fontWeight: FontWeight.bold,
              fontFamily: 'monospace',
            ),
          ),
        ],
      ),
    );
  }

  Color _getOffsetColor(int offset) {
    final absOffset = offset.abs();
    if (absOffset < 5) return Colors.green;
    if (absOffset < 20) return Colors.yellow;
    return Colors.red;
  }

  Color _getRttColor(int rtt) {
    if (rtt < 10) return Colors.green;
    if (rtt < 50) return Colors.yellow;
    return Colors.red;
  }

  Color _getJitterColor(int jitter) {
    if (jitter < 2) return Colors.green;
    if (jitter < 10) return Colors.yellow;
    return Colors.red;
  }
}
