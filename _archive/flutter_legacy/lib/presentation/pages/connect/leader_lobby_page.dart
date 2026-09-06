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
  final String _sessionToken = DateTime.now().millisecondsSinceEpoch.toString();

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

    _localIp ??= '127.0.0.1'; // Fallback so QR still renders

    // 2. Start Hosting (TCP + NSD)
    try {
      await _sessionRepo.startHosting(
        sessionName: "Bandait-${widget.userProfile.name}",
        port: 4567, // Tries 4567, falls back to dynamic port internally
      );
    } catch (e) {
      debugPrint('Error in startHosting: $e');
      // Even if startHosting had an error not caught internally, we force UI render
    }

    if (mounted) {
      setState(() => _isHosting = true);
    }
  }

  String _getQrData() {
    final data = {
      'h': _localIp,
      'p': _sessionRepo.activePort, // Read the actual port used
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
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'THE ROCKERS',
              style: TextStyle(
                fontFamily: 'Space Grotesk',
                fontSize: 24,
                fontWeight: FontWeight.bold,
                letterSpacing: 2,
              ),
            ),
            Row(
              children: [
                const Icon(Icons.wifi_tethering, size: 12, color: Colors.grey),
                const SizedBox(width: 4),
                Text(
                  'NETWORK: LOCAL-5G',
                  style: TextStyle(
                    fontFamily: 'Courier',
                    fontSize: 10,
                    color: Colors.grey[500],
                    letterSpacing: 2,
                  ),
                ),
              ],
            ),
          ],
        ),
        backgroundColor: Colors.transparent,
        elevation: 0,
        actions: [
          IconButton(
            icon: const Icon(Icons.settings, color: Colors.white, size: 28),
            onPressed: () {
              // Open Settings Dialog (End Session etc)
              _showSettingsDialog();
            },
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: !_isHosting
          ? const Center(
              child: CircularProgressIndicator(color: AppTheme.primaryColor),
            )
          : VisualMetronome(
              child: Stack(
                children: [
                  // Scan Line Background effect could be here
                  SingleChildScrollView(
                    padding: const EdgeInsets.fromLTRB(16, 16, 16, 100),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        // Connection Hub / QR Card
                        Container(
                          width: double.infinity,
                          decoration: BoxDecoration(
                            color: const Color(0xFF121212), // surface-dark
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(color: Colors.white10),
                            boxShadow: [
                              BoxShadow(
                                color: AppTheme.primaryColor.withOpacity(0.15),
                                blurRadius: 15,
                                spreadRadius: 0,
                              ),
                            ],
                          ),
                          padding: const EdgeInsets.all(24),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.center,
                            children: [
                              // QR Code with Glow
                              Container(
                                decoration: BoxDecoration(
                                  color: Colors.white,
                                  borderRadius: BorderRadius.circular(8),
                                  boxShadow: [
                                    BoxShadow(
                                      color: AppTheme.primaryColor.withOpacity(
                                        0.5,
                                      ),
                                      blurRadius: 20,
                                      spreadRadius: 2,
                                    ),
                                  ],
                                ),
                                padding: const EdgeInsets.all(12),
                                child: QrImageView(
                                  data: _getQrData(),
                                  version: QrVersions.auto,
                                  size: 160,
                                  backgroundColor: Colors.white,
                                ),
                              ),
                              const SizedBox(height: 24),
                              const Text(
                                'JOIN CODE',
                                style: TextStyle(
                                  fontSize: 12,
                                  fontWeight: FontWeight.w500,
                                  color: Colors.grey,
                                  letterSpacing: 2,
                                ),
                              ),
                              const SizedBox(height: 4),
                              Text(
                                '$_localIp:${_sessionRepo.activePort}',
                                style: const TextStyle(
                                  fontFamily: 'Courier',
                                  fontSize: 22,
                                  fontWeight: FontWeight.bold,
                                  color: AppTheme.primaryColor,
                                  letterSpacing: 2,
                                ),
                              ),
                              const SizedBox(height: 16),
                              const Text(
                                'Scan to sync instantly. Keep screen active while connecting.',
                                textAlign: TextAlign.center,
                                style: TextStyle(
                                  fontSize: 12,
                                  color: Colors.grey,
                                ),
                              ),
                            ],
                          ),
                        ),

                        const SizedBox(height: 32),

                        // Section Header
                        StreamBuilder<List<String>>(
                          stream: _sessionRepo.connectedPeers,
                          initialData: const [],
                          builder: (context, snapshot) {
                            final peers = snapshot.data ?? [];
                            return Column(
                              children: [
                                Padding(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 8,
                                  ),
                                  child: Row(
                                    mainAxisAlignment:
                                        MainAxisAlignment.spaceBetween,
                                    children: [
                                      Row(
                                        children: [
                                          const Text(
                                            'BAND MEMBERS',
                                            style: TextStyle(
                                              color: Colors.white,
                                              fontSize: 16,
                                              fontWeight: FontWeight.bold,
                                              letterSpacing: 1.5,
                                            ),
                                          ),
                                          const SizedBox(width: 8),
                                          Container(
                                            padding: const EdgeInsets.symmetric(
                                              horizontal: 8,
                                              vertical: 2,
                                            ),
                                            decoration: BoxDecoration(
                                              color: Colors.white10,
                                              borderRadius:
                                                  BorderRadius.circular(12),
                                            ),
                                            child: Text(
                                              '${peers.length + 1}/4',
                                              style: const TextStyle(
                                                fontFamily: 'Courier',
                                                color: AppTheme.primaryColor,
                                                fontSize: 10,
                                                fontWeight: FontWeight.bold,
                                              ),
                                            ),
                                          ),
                                        ],
                                      ),
                                      Row(
                                        children: [
                                          Container(
                                            width: 6,
                                            height: 6,
                                            decoration: BoxDecoration(
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
                                    ],
                                  ),
                                ),
                                const SizedBox(height: 16),

                                // Member Grid
                                GridView.count(
                                  crossAxisCount: 2,
                                  shrinkWrap: true,
                                  physics: const NeverScrollableScrollPhysics(),
                                  mainAxisSpacing: 12,
                                  crossAxisSpacing: 12,
                                  childAspectRatio: 1.25,
                                  children: [
                                    // Me (Host)
                                    _buildMusicianSlot(
                                      name: widget.userProfile.name,
                                      instrument: widget.userProfile.instrument,
                                      status: 'LOCKED',
                                      color: AppTheme.primaryColor,
                                    ),
                                    // Peers
                                    for (var i = 0; i < 3; i++)
                                      if (i < peers.length)
                                        _buildMusicianSlot(
                                          name:
                                              'Guest-${peers[i].split('.').last}',
                                          instrument: 'Unknown',
                                          status: 'SYNCING',
                                          color: Colors
                                              .amber, // Using amber for syncing like HTML status-sync
                                        )
                                      else
                                        _buildEmptySlot(),
                                  ],
                                ),
                              ],
                            );
                          },
                        ),

                        const SizedBox(height: 32),
                        const Center(
                          child: Opacity(
                            opacity: 0.4,
                            child: Text(
                              'V2.4.0 • ZERO LATENCY ENGINE ACTIVE',
                              style: TextStyle(
                                fontFamily: 'Courier',
                                fontSize: 10,
                                color: Colors.grey,
                                letterSpacing: 1,
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(height: 20),
                      ],
                    ),
                  ),

                  // Bottom Action Bar
                  Positioned(
                    bottom: 0,
                    left: 0,
                    right: 0,
                    child: Container(
                      padding: const EdgeInsets.all(24),
                      decoration: const BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.bottomCenter,
                          end: Alignment.topCenter,
                          colors: [Colors.black, Colors.transparent],
                          stops: [0.3, 1.0],
                        ),
                      ),
                      child: ElevatedButton(
                        style: ElevatedButton.styleFrom(
                          backgroundColor: AppTheme.primaryColor,
                          padding: const EdgeInsets.symmetric(vertical: 20),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12),
                          ),
                        ),
                        onPressed: () {
                          // TODO: Navigate to active setlist or start metronome
                          _sessionRepo.startMetronome(120.0);
                        },
                        child: const Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Text(
                              'START SETLIST',
                              style: TextStyle(
                                fontFamily: 'Space Grotesk',
                                color: Colors.black,
                                fontSize: 18,
                                fontWeight: FontWeight.w900,
                                letterSpacing: 2,
                              ),
                            ),
                            SizedBox(width: 12),
                            Icon(Icons.arrow_forward, color: Colors.black),
                          ],
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
    );
  }

  void _showSettingsDialog() {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF121212),
        title: const Text(
          'SESSION SETTINGS',
          style: TextStyle(color: Colors.white, fontFamily: 'Space Grotesk'),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(
                Icons.volume_up,
                color: AppTheme.primaryColor,
              ),
              title: const Text(
                'Audio Engine Status',
                style: TextStyle(color: Colors.white),
              ),
              subtitle: Text(
                getIt<AudioEngine>().isInitialized ? 'Ready' : 'Error',
                style: TextStyle(
                  color: getIt<AudioEngine>().isInitialized
                      ? Colors.green
                      : Colors.red,
                ),
              ),
              onTap: getIt<AudioEngine>().isInitialized
                  ? null
                  : () => getIt<AudioEngine>().initialize(),
            ),
            ListTile(
              leading: const Icon(Icons.stop_circle, color: Colors.red),
              title: const Text(
                'Panic Stop All',
                style: TextStyle(color: Colors.white),
              ),
              onTap: () {
                _sessionRepo.sendPanic();
                Navigator.pop(ctx);
              },
            ),
          ],
        ),
        actions: [
          TextButton(
            child: const Text('CLOSE', style: TextStyle(color: Colors.grey)),
            onPressed: () => Navigator.pop(ctx),
          ),
          TextButton(
            child: const Text(
              'END SESSION',
              style: TextStyle(color: Colors.red, fontWeight: FontWeight.bold),
            ),
            onPressed: () {
              Navigator.pop(ctx);
              Navigator.pop(context);
            },
          ),
        ],
      ),
    );
  }

  Widget _buildMusicianSlot({
    required String name,
    required String instrument,
    required String status,
    required Color color,
  }) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: const Color(0xFF121212), // surface-dark
        border: Border.all(color: color.withOpacity(0.4)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Container(
                width: 32,
                height: 32,
                decoration: BoxDecoration(
                  color: color.withOpacity(0.1),
                  shape: BoxShape.circle,
                ),
                child: Icon(
                  _getIconForInstrument(instrument),
                  color: color,
                  size: 16,
                ),
              ),
              if (status == 'LOCKED')
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: color,
                    shape: BoxShape.circle,
                    boxShadow: [BoxShadow(color: color, blurRadius: 8)],
                  ),
                ),
              if (status == 'SYNCING')
                Icon(Icons.sync, color: color, size: 16), // Could animate
            ],
          ),
          const Spacer(),
          Text(
            name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: Colors.white,
              fontWeight: FontWeight.bold,
              fontSize: 16,
            ),
          ),
          const SizedBox(height: 4),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                instrument.toUpperCase(),
                style: const TextStyle(
                  color: Colors.grey,
                  fontSize: 10,
                  letterSpacing: 1,
                ),
              ),
              Text(
                status,
                style: TextStyle(
                  fontFamily: 'Courier',
                  color: color,
                  fontSize: 10,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Container(
            height: 2,
            width: double.infinity,
            decoration: BoxDecoration(
              color: Colors.white10,
              borderRadius: BorderRadius.circular(2),
            ),
            child: FractionallySizedBox(
              alignment: Alignment.centerLeft,
              widthFactor: status == 'LOCKED' ? 1.0 : 0.75,
              child: Container(
                decoration: BoxDecoration(
                  color: color,
                  borderRadius: BorderRadius.circular(2),
                  boxShadow: [BoxShadow(color: color, blurRadius: 4)],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildEmptySlot() {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.black,
        border: Border.all(
          color: Colors.white24,
          style: BorderStyle.solid,
        ), // Flutter doesn't support dashed easily without package, using solid with opacity
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 32,
            height: 32,
            decoration: const BoxDecoration(
              color: Colors.white10,
              shape: BoxShape.circle,
            ),
            child: const Icon(Icons.add, color: Colors.grey, size: 16),
          ),
          const Spacer(),
          const Text(
            'Open Slot',
            style: TextStyle(
              color: Colors.grey,
              fontWeight: FontWeight.bold,
              fontSize: 16,
            ),
          ),
          const SizedBox(height: 4),
          const Text(
            'ANY',
            style: TextStyle(
              color: Colors.grey,
              fontSize: 10,
              letterSpacing: 1,
            ),
          ),
          const SizedBox(height: 12),
          const Align(
            alignment: Alignment.centerRight,
            child: Text(
              'WAITING',
              style: TextStyle(
                fontFamily: 'Courier',
                color: Colors.grey,
                fontSize: 10,
              ),
            ),
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
