import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import '../../core/di/injection.dart';
import '../bloc/metronome/metronome_bloc.dart';
import '../bloc/metronome/metronome_state.dart';
import '../../../application/distributed_metronome_manager.dart';

class MetronomePage extends StatelessWidget {
  final bool isLeader;

  const MetronomePage({super.key, required this.isLeader});

  @override
  Widget build(BuildContext context) {
    return BlocProvider(
      create: (_) => getIt<MetronomeBloc>(),
      child: _MetronomeView(isLeader: isLeader),
    );
  }
}

class _MetronomeView extends StatelessWidget {
  final bool isLeader;

  const _MetronomeView({required this.isLeader});

  @override
  Widget build(BuildContext context) {
    final manager = getIt<DistributedMetronomeManager>();

    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: Text('METRONOME ${isLeader ? "(LEADER)" : "(FOLLOWER)"}'),
        backgroundColor: Colors.transparent,
      ),
      body: BlocBuilder<MetronomeBloc, MetronomeState>(
        builder: (context, state) {
          final isControlsEnabled = isLeader; // Only Leader controls

          return Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(16.0),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  // BPM Display
                  Text(
                    '${state.bpm}',
                    style: TextStyle(
                      fontSize: 96,
                      fontWeight: FontWeight.bold,
                      color: isControlsEnabled ? Colors.white : Colors.grey,
                    ),
                  ),
                  const Text(
                    'BPM',
                    style: TextStyle(color: Colors.grey, fontSize: 24),
                  ),
                  const SizedBox(height: 48),

                  // Visual Beat Indicator
                  Container(
                    width: 100,
                    height: 100,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: state.currentBeat == 1
                          ? Theme.of(context).primaryColor
                          : (state.isPlaying
                                ? Theme.of(
                                    context,
                                  ).primaryColor.withOpacity(0.3)
                                : Theme.of(context).cardColor),
                      boxShadow: state.currentBeat == 1
                          ? [
                              BoxShadow(
                                color: Theme.of(
                                  context,
                                ).primaryColor.withOpacity(0.8),
                                blurRadius: 30,
                                spreadRadius: 10,
                              ),
                            ]
                          : [],
                    ),
                    child: Center(
                      child: Text(
                        state.isPlaying ? '${state.currentBeat}' : '-',
                        style: const TextStyle(
                          fontSize: 40,
                          fontWeight: FontWeight.bold,
                          color: Colors.white,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 64),

                  // Controls
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      // Decrease BPM
                      Opacity(
                        opacity: isControlsEnabled ? 1.0 : 0.3,
                        child: IconButton(
                          icon: const Icon(
                            Icons.remove_circle_outline,
                            size: 48,
                            color: Colors.grey,
                          ),
                          onPressed: isControlsEnabled
                              ? () {
                                  // Distributed BPM Change
                                  manager.sendBpmChange(state.bpm - 1);
                                }
                              : null,
                        ),
                      ),
                      const SizedBox(width: 32),

                      // Play/Stop Button
                      GestureDetector(
                        onTap: () {
                          if (!isControlsEnabled) return;

                          if (state.isPlaying) {
                            manager.sendStopCommand();
                          } else {
                            // Start in 2 seconds (2000ms)
                            manager.sendStartCommand(2000, state.bpm);
                          }
                        },
                        child: Opacity(
                          opacity: isControlsEnabled ? 1.0 : 0.5,
                          child: Container(
                            width: 120,
                            height: 120,
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              color: state.isPlaying
                                  ? Colors.red
                                  : Colors.green,
                            ),
                            child: Icon(
                              state.isPlaying ? Icons.stop : Icons.play_arrow,
                              size: 64,
                              color: Colors.white,
                            ),
                          ),
                        ),
                      ),

                      const SizedBox(width: 32),
                      // Increase BPM
                      Opacity(
                        opacity: isControlsEnabled ? 1.0 : 0.3,
                        child: IconButton(
                          icon: const Icon(
                            Icons.add_circle_outline,
                            size: 48,
                            color: Colors.grey,
                          ),
                          onPressed: isControlsEnabled
                              ? () => manager.sendBpmChange(state.bpm + 1)
                              : null,
                        ),
                      ),
                    ],
                  ),

                  const SizedBox(height: 32),

                  // Slider
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 48.0),
                    child: Slider(
                      value: state.bpm.toDouble(),
                      min: 40,
                      max: 240,
                      activeColor: isControlsEnabled
                          ? Theme.of(context).primaryColor
                          : Colors.grey,
                      inactiveColor: const Color(0xFF1a1a1a),
                      onChanged: isControlsEnabled
                          ? (value) {
                              manager.sendBpmChange(value.toInt());
                            }
                          : null,
                    ),
                  ),

                  if (!isLeader) ...[
                    const SizedBox(height: 24),
                    const Text(
                      'Waiting for Leader...',
                      style: TextStyle(
                        color: Colors.orange,
                        fontStyle: FontStyle.italic,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}
