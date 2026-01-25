import 'dart:io';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:bandait/core/di/injection.dart';
import 'package:bandait/domain/repositories/session_repository.dart';
import 'package:bandait/domain/repositories/audio_engine.dart';
import 'package:bandait/domain/models/user_profile.dart';
import 'package:bandait/presentation/theme/app_theme.dart';
import 'package:bandait/presentation/widgets/visual_metronome.dart';

class LeaderLobbyPage extends StatefulWidget {
  final UserProfile userProfile;

  const LeaderLobbyPage({super.key, required this.userProfile});

  @override
  State<LeaderLobbyPage> createState() => _LeaderLobbyPageState();
}

class _LeaderLobbyPageState extends State<LeaderLobbyPage> {
  final _sessionRepo = getIt<SessionRepository>();
  String? _localIp;
  bool _isHosting = false;
  final int _port = 4567; // Fixed port for Bandait
  final String _sessionToken = DateTime.now().millisecondsSinceEpoch.toString();
  double _bpm = 120.0;
  bool _isPlaying = false;

  @override
  void initState() {
    super.initState();
    WakelockPlus.enable();
    _startSession();
  }

  @override
  void dispose() {
    WakelockPlus.disable();
    _sessionRepo.stopHosting();
    super.dispose();
  }

  Future<void> _startSession() async {
    // 1. Get Local IP
    try {
      final interfaces = await NetworkInterface.list(
        type: InternetAddressType.IPv4,
      );
      for (var interface in interfaces) {
        for (var addr in interface.addresses) {
          if (!addr.isLoopback) {
            _localIp = addr.address;
            break;
          }
        }
        if (_localIp != null) break;
      }
    } catch (e) {
      debugPrint('Error getting IP: $e');
    }

    _localIp ??= '127.0.0.1'; // Fallback

    // 2. Start NSD Broadcast
    await _sessionRepo.startHosting(
      sessionName: "Bandait-${widget.userProfile.name}",
      port: _port,
    );

    if (mounted) {
      setState(() => _isHosting = true);
    }
  }

  String _getQrData() {
    final data = {
      'h': _localIp,
      'p': _port,
      't': _sessionToken,
      'n': widget.userProfile.name,
    };
    return jsonEncode(data);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.darkBackground,
      appBar: AppBar(
        title: const Text('BAND LEADER'),
        backgroundColor: AppTheme.cardBackground,
        centerTitle: true,
        actions: [
          // Audio Status Icon
          IconButton(
            icon: Icon(
              getIt<AudioEngine>().isInitialized
                  ? Icons.volume_up
                  : Icons.volume_off,
              color: getIt<AudioEngine>().isInitialized
                  ? Colors.green
                  : Colors.red,
            ),
            tooltip: getIt<AudioEngine>().isInitialized
                ? 'Audio Ready'
                : 'Audio Error (Tap to fix)',
            onPressed: getIt<AudioEngine>().isInitialized
                ? null
                : () async {
                    await getIt<AudioEngine>().initialize();
                    setState(() {});
                  },
          ),
          IconButton(
            icon: const Icon(Icons.exit_to_app, color: Colors.red),
            onPressed: () {
              // Confirm Exit
              showDialog(
                context: context,
                builder: (ctx) => AlertDialog(
                  backgroundColor: AppTheme.cardBackground,
                  title: const Text(
                    'End Session?',
                    style: TextStyle(color: Colors.white),
                  ),
                  content: const Text(
                    'This will disconnect all musicians.',
                    style: TextStyle(color: Colors.white70),
                  ),
                  actions: [
                    TextButton(
                      child: const Text('Cancel'),
                      onPressed: () => Navigator.pop(ctx),
                    ),
                    TextButton(
                      child: const Text(
                        'END',
                        style: TextStyle(color: Colors.red),
                      ),
                      onPressed: () {
                        Navigator.pop(ctx); // Close dialog
                        Navigator.pop(context); // Exit page
                      },
                    ),
                  ],
                ),
              );
            },
          ),
        ],
      ),
      body: !_isHosting
          ? const Center(
              child: CircularProgressIndicator(color: AppTheme.primaryColor),
            )
          : VisualMetronome(
              child: SingleChildScrollView(
                child: Padding(
                  padding: const EdgeInsets.all(24.0),
                  child: Column(
                    children: [
                      Container(
                        padding: const EdgeInsets.all(16),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(16),
                        ),
                        child: QrImageView(
                          data: _getQrData(),
                          version: QrVersions.auto,
                          size: 250,
                          backgroundColor: Colors.white,
                        ),
                      ),
                      const SizedBox(height: 24),
                      const Text(
                        'SCAN TO JOIN',
                        style: TextStyle(
                          color: AppTheme.primaryColor,
                          fontSize: 24,
                          fontWeight: FontWeight.bold,
                          letterSpacing: 2,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        '$_localIp:$_port',
                        style: const TextStyle(
                          color: Colors.grey,
                          fontFamily: 'Courier',
                        ),
                      ),
                      const SizedBox(height: 24),
                      // Controls
                      Container(
                        padding: const EdgeInsets.all(16),
                        decoration: BoxDecoration(
                          color: AppTheme.cardBackground,
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Column(
                          children: [
                            const Text(
                              'STAGE CONTROLS',
                              style: TextStyle(
                                color: Colors.white,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                            const SizedBox(height: 16),
                            Row(
                              children: [
                                Text(
                                  'BPM: ${_bpm.round()}',
                                  style: const TextStyle(color: Colors.white),
                                ),
                                Expanded(
                                  child: Slider(
                                    value: _bpm,
                                    min: 40,
                                    max: 200,
                                    activeColor: AppTheme.primaryColor,
                                    onChanged: (v) => setState(() => _bpm = v),
                                  ),
                                ),
                              ],
                            ),
                            Row(
                              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                              children: [
                                ElevatedButton.icon(
                                  icon: Icon(
                                    _isPlaying
                                        ? Icons.music_note
                                        : Icons.play_arrow,
                                    color: Colors.white,
                                  ),
                                  label: Text(
                                    _isPlaying ? 'PLAYING...' : 'START',
                                  ),
                                  style: ElevatedButton.styleFrom(
                                    backgroundColor: _isPlaying
                                        ? Colors.orange
                                        : Colors.green,
                                  ),
                                  onPressed: _isPlaying
                                      ? null
                                      : () {
                                          _sessionRepo.startMetronome(_bpm);
                                          setState(() => _isPlaying = true);
                                        },
                                ),
                                ElevatedButton.icon(
                                  icon: const Icon(Icons.stop),
                                  label: const Text('STOP'),
                                  style: ElevatedButton.styleFrom(
                                    backgroundColor: Colors.grey,
                                  ),
                                  onPressed: () {
                                    _sessionRepo.stopMetronome();
                                    setState(() => _isPlaying = false);
                                  },
                                ),
                              ],
                            ),
                            const SizedBox(height: 12),
                            SizedBox(
                              width: double.infinity,
                              child: ElevatedButton.icon(
                                icon: const Icon(Icons.warning),
                                label: const Text('PANIC STOP ALL'),
                                style: ElevatedButton.styleFrom(
                                  backgroundColor: Colors.red,
                                ),
                                onPressed: () => _sessionRepo.sendPanic(),
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 24),
                      // Connected Peers List
                      StreamBuilder<List<String>>(
                        stream: _sessionRepo.connectedPeers,
                        initialData: const [],
                        builder: (context, snapshot) {
                          final peers = snapshot.data ?? [];
                          return Container(
                            width: double.infinity,
                            padding: const EdgeInsets.all(20),
                            decoration: BoxDecoration(
                              color: AppTheme.cardBackground,
                              borderRadius: BorderRadius.circular(12),
                              border: Border.all(color: Colors.white10),
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  mainAxisAlignment:
                                      MainAxisAlignment.spaceBetween,
                                  children: [
                                    const Text(
                                      'CONNECTED MUSICIANS',
                                      style: TextStyle(
                                        color: Colors.white,
                                        fontWeight: FontWeight.bold,
                                        fontSize: 13,
                                        letterSpacing: 1.2,
                                      ),
                                    ),
                                    Container(
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 6,
                                        vertical: 2,
                                      ),
                                      decoration: BoxDecoration(
                                        color: Colors.white10,
                                        borderRadius: BorderRadius.circular(4),
                                      ),
                                      child: Text(
                                        '${peers.length + 1}/4',
                                        style: const TextStyle(
                                          color: AppTheme.primaryColor,
                                          fontSize: 10,
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                                const Divider(
                                  color: Colors.white24,
                                  height: 24,
                                ),
                                // Leader (Self)
                                _buildMemberCard(
                                  name: widget.userProfile.name,
                                  instrument: widget.userProfile.instrument,
                                  isMe: true,
                                ),
                                const SizedBox(height: 12),
                                // Peers
                                if (peers.isEmpty)
                                  const Padding(
                                    padding: EdgeInsets.symmetric(vertical: 20),
                                    child: Center(
                                      child: Text(
                                        'Waiting for connections...',
                                        style: TextStyle(
                                          color: Colors.white38,
                                          fontStyle: FontStyle.italic,
                                        ),
                                      ),
                                    ),
                                  )
                                else
                                  ...peers.map(
                                    (peer) => Padding(
                                      padding: const EdgeInsets.only(
                                        bottom: 12,
                                      ),
                                      child: _buildMemberCard(
                                        name: 'Guest (${peer.split('.').last})',
                                        instrument: 'Unknown',
                                        isMe: false,
                                      ),
                                    ),
                                  ),
                              ],
                            ),
                          );
                        },
                      ),
                    ],
                  ),
                ),
              ),
            ),
    );
  }

  Widget _buildMemberCard({
    required String name,
    required String instrument,
    required bool isMe,
  }) {
    // Styling based on Stitch leader_session_lobby/code.html member cards
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFF141414), // Surface dark
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: Colors.white10),
      ),
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: AppTheme.primaryColor.withOpacity(0.1),
              borderRadius: BorderRadius.circular(6),
              border: Border.all(color: AppTheme.primaryColor.withOpacity(0.2)),
            ),
            child: Icon(
              _getIconForInstrument(instrument),
              color: AppTheme.primaryColor,
              size: 20,
            ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(
                      name,
                      style: const TextStyle(
                        color: Colors.white,
                        fontWeight: FontWeight.bold,
                        fontSize: 14,
                      ),
                    ),
                    const SizedBox(width: 8),
                    if (isMe)
                      Container(
                        height: 6,
                        width: 6,
                        decoration: const BoxDecoration(
                          color: AppTheme.primaryColor,
                          shape: BoxShape.circle,
                          boxShadow: [
                            BoxShadow(
                              color: AppTheme.primaryColor,
                              blurRadius: 4,
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
                const SizedBox(height: 2),
                Text(
                  instrument.toUpperCase(),
                  style: const TextStyle(
                    color: Colors.grey,
                    fontSize: 10,
                    letterSpacing: 1,
                  ),
                ),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                isMe ? 'HOST' : 'CONNECTED',
                style: TextStyle(
                  color: isMe ? AppTheme.primaryColor : Colors.green,
                  fontSize: 10,
                  fontWeight: FontWeight.bold,
                ),
              ),
              if (!isMe)
                const Text(
                  '< 1ms',
                  style: TextStyle(
                    color: Colors.white38,
                    fontSize: 10,
                    fontFamily: 'Courier',
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }

  IconData _getIconForInstrument(String instrument) {
    switch (instrument.toLowerCase()) {
      case 'drums':
        return Icons.circle;
      case 'guitar':
        return Icons.music_note;
      case 'bass':
        return Icons.music_note;
      case 'vocals':
        return Icons.mic;
      case 'keys':
        return Icons.piano;
      default:
        return Icons.person;
    }
  }
}
