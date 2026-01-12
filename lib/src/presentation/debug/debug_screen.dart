import 'package:flutter/material.dart';
import '../../domain/entities/sync_stats.dart';
import '../../domain/repositories/sync_repository.dart';
import 'widgets/stat_card.dart';
import 'widgets/flash_test.dart';

class DebugScreen extends StatefulWidget {
  final SyncRepository repository;

  const DebugScreen({super.key, required this.repository});

  @override
  State<DebugScreen> createState() => _DebugScreenState();
}

class _DebugScreenState extends State<DebugScreen> {
  late Stream<SyncStats> _statsStream;
  late Stream<bool> _flashStream;

  @override
  void initState() {
    super.initState();
    _statsStream = widget.repository.statsStream;
    _flashStream = widget.repository.flashTriggerStream;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: const Text('Debug Técnico'),
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
      ),
      body: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Stats Grid
            Expanded(
              child: StreamBuilder<SyncStats>(
                stream: _statsStream,
                initialData: SyncStats.empty(),
                builder: (context, snapshot) {
                  final stats = snapshot.data ?? SyncStats.empty();
                  return GridView.count(
                    crossAxisCount: 2,
                    crossAxisSpacing: 16,
                    mainAxisSpacing: 16,
                    children: [
                      StatCard(
                        title: 'Offset',
                        value: stats.offsetMs.toString(),
                        unit: 'ms',
                        icon: Icons.access_time,
                        color: Colors.blueAccent,
                      ),
                      StatCard(
                        title: 'RTT',
                        value: stats.rttMs.toString(),
                        unit: 'ms',
                        icon: Icons.swap_horiz,
                        color: _getRttColor(stats.rttMs),
                      ),
                      StatCard(
                        title: 'Jitter',
                        value: stats.jitterMs.toString(),
                        unit: 'ms',
                        icon: Icons.waves,
                        color: _getJitterColor(stats.jitterMs),
                      ),
                      _buildUpdateIndicator(stats.lastUpdated),
                    ],
                  );
                },
              ),
            ),

            const SizedBox(height: 24),

            // Flash Test Area
            StreamBuilder<bool>(
              stream: _flashStream,
              initialData: false,
              builder: (context, snapshot) {
                return FlashTest(isFlashing: snapshot.data ?? false);
              },
            ),

            const SizedBox(height: 16),

            // Action Buttons
            ElevatedButton.icon(
              onPressed: () {
                widget.repository.triggerFlashTest();
              },
              icon: const Icon(Icons.flash_on),
              label: const Text('TRIGGER FLASH TEST'),
              style: ElevatedButton.styleFrom(
                backgroundColor: Colors.white,
                foregroundColor: Colors.black,
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Color _getRttColor(int rtt) {
    if (rtt < 10) return Colors.greenAccent;
    if (rtt < 20) return Colors.amberAccent;
    return Colors.redAccent;
  }

  Color _getJitterColor(int jitter) {
    if (jitter < 2) return Colors.greenAccent;
    if (jitter < 5) return Colors.amberAccent;
    return Colors.redAccent;
  }

  Widget _buildUpdateIndicator(DateTime lastUpdated) {
    return Card(
      color: Colors.grey[900],
      child: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.refresh, color: Colors.white54, size: 32),
            const SizedBox(height: 8),
            const Text(
              'Last Update',
              style: TextStyle(color: Colors.white70, fontSize: 14),
            ),
            const SizedBox(height: 4),
            Text(
              '${lastUpdated.hour}:${lastUpdated.minute}:${lastUpdated.second}',
              style: const TextStyle(
                color: Colors.white,
                fontSize: 18,
                fontWeight: FontWeight.bold,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
