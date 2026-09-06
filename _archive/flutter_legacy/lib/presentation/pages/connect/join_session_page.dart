import 'dart:convert';
import 'package:wakelock_plus/wakelock_plus.dart';
import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:bandait/core/di/injection.dart';
import 'package:bandait/domain/repositories/session_repository.dart';
import 'package:bandait/domain/models/user_profile.dart';
import 'package:bandait/presentation/theme/app_theme.dart';
import 'package:bandait/presentation/widgets/network_health_widget.dart';
import 'package:bandait/presentation/widgets/panic_overlay.dart';
import 'package:bandait/presentation/widgets/visual_metronome.dart';

class JoinSessionPage extends StatefulWidget {
  final UserProfile userProfile;

  const JoinSessionPage({super.key, required this.userProfile});

  @override
  State<JoinSessionPage> createState() => _JoinSessionPageState();
}

class _JoinSessionPageState extends State<JoinSessionPage>
    with SingleTickerProviderStateMixin {
  final _sessionRepo = getIt<SessionRepository>();
  late TabController _tabController;
  bool _isScanning = false;
  MobileScannerController? _scannerController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _requestPermissions();
    _sessionRepo.startDiscovery();
  }

  Future<void> _requestPermissions() async {
    await Permission.camera.request();
    await Permission.location
        .request(); // Android often needs location for WiFi discovery
  }

  @override
  void dispose() {
    _sessionRepo.stopDiscovery();
    _scannerController?.dispose();
    _tabController.dispose();
    super.dispose();
  }

  void _onQrDetect(BarcodeCapture capture) {
    if (_isScanning) return; // Prevent double trigger

    final List<Barcode> barcodes = capture.barcodes;
    for (final barcode in barcodes) {
      if (barcode.rawValue != null) {
        try {
          final data = jsonDecode(barcode.rawValue!);
          if (data['h'] != null && data['p'] != null) {
            _connectToSession(data['h'], data['p'], data['n']);
            setState(() => _isScanning = true);
            return;
          }
        } catch (e) {
          // not a valid json or bandait qr
        }
      }
    }
  }

  void _connectToSession(String host, int port, String? name) async {
    _sessionRepo.stopDiscovery();
    _scannerController?.stop();

    // Show connecting dialog
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppTheme.cardBackground,
        title: Text('Connecting to ${name ?? "Session"}...'),
        content: const Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircularProgressIndicator(color: AppTheme.primaryColor),
            SizedBox(height: 16),
            Text('Shaking hands...', style: TextStyle(color: Colors.white70)),
          ],
        ),
      ),
    );

    try {
      await _sessionRepo.connectTo(host, port);

      if (mounted) {
        Navigator.pop(context); // Close connecting dialog

        // Navigate to Stage View (or simple Health View for now)
        Navigator.push(
          context,
          MaterialPageRoute(
            builder: (_) => _ConnectedStageView(sessionName: name),
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        Navigator.pop(context);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Connection Failed: $e'),
            backgroundColor: Colors.red,
          ),
        );
        setState(() => _isScanning = false); // Allow rescan
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.darkBackground,
      appBar: AppBar(
        title: const Text('JOIN SESSION'),
        backgroundColor: AppTheme.cardBackground,
        bottom: TabBar(
          controller: _tabController,
          indicatorColor: AppTheme.primaryColor,
          tabs: const [
            Tab(text: 'SCAN QR', icon: Icon(Icons.qr_code_scanner)),
            Tab(text: 'NEARBY', icon: Icon(Icons.radar)),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [_buildScannerTab(), _buildDiscoveryTab()],
      ),
    );
  }

  Widget _buildScannerTab() {
    return Column(
      children: [
        Expanded(
          flex: 2,
          child: Container(
            margin: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              border: Border.all(color: AppTheme.primaryColor, width: 2),
              borderRadius: BorderRadius.circular(12),
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(11),
              child: MobileScanner(
                controller: _scannerController ??= MobileScannerController(
                  detectionSpeed: DetectionSpeed.normal,
                ),
                onDetect: _onQrDetect,
              ),
            ),
          ),
        ),
        const Expanded(
          flex: 1,
          child: Center(
            child: Text(
              'Point camera at Leader\'s QR Code',
              style: TextStyle(color: Colors.grey),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildDiscoveryTab() {
    return StreamBuilder<List<BandSession>>(
      stream: _sessionRepo.discoveredSessions,
      initialData: const [],
      builder: (context, snapshot) {
        final sessions = snapshot.data ?? [];
        if (sessions.isEmpty) {
          return const Center(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                CircularProgressIndicator(color: Colors.white10),
                SizedBox(height: 16),
                Text(
                  'Scanning for local bands...',
                  style: TextStyle(color: Colors.white38),
                ),
              ],
            ),
          );
        }

        return ListView.builder(
          itemCount: sessions.length,
          padding: const EdgeInsets.all(16),
          itemBuilder: (context, index) {
            final session = sessions[index];
            return Card(
              color: AppTheme.cardBackground,
              margin: const EdgeInsets.only(bottom: 12),
              child: ListTile(
                leading: const Icon(
                  Icons.music_note,
                  color: AppTheme.primaryColor,
                ),
                title: Text(
                  session.name,
                  style: const TextStyle(color: Colors.white),
                ),
                subtitle: Text(
                  '${session.host}:${session.port}',
                  style: const TextStyle(color: Colors.grey),
                ),
                trailing: ElevatedButton(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppTheme.primaryColor,
                  ),
                  onPressed: () => _connectToSession(
                    session.host,
                    session.port,
                    session.name,
                  ),
                  child: const Text(
                    'JOIN',
                    style: TextStyle(color: Colors.black),
                  ),
                ),
              ),
            );
          },
        );
      },
    );
  }
}

class _ConnectedStageView extends StatefulWidget {
  final String? sessionName;

  const _ConnectedStageView({this.sessionName});

  @override
  State<_ConnectedStageView> createState() => _ConnectedStageViewState();
}

class _ConnectedStageViewState extends State<_ConnectedStageView> {
  @override
  void initState() {
    super.initState();
    WakelockPlus.enable();
  }

  @override
  void dispose() {
    WakelockPlus.disable();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final repo = getIt<SessionRepository>();

    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: Text(widget.sessionName ?? 'LIVE SESSION'),
        backgroundColor: Colors.black,
        leading: IconButton(
          icon: const Icon(Icons.close),
          onPressed: () => Navigator.pop(context),
        ),
      ),
      body: PanicOverlay(
        child: VisualMetronome(
          child: Center(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Icon(Icons.link, size: 80, color: AppTheme.primaryColor),
                const SizedBox(height: 24),
                Text(
                  'CONNECTED TO ${widget.sessionName?.toUpperCase() ?? "BAND"}',
                  style: const TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.bold,
                    fontSize: 18,
                    letterSpacing: 1.5,
                  ),
                ),
                const SizedBox(height: 48),
                // Network Health Monitor
                StreamBuilder<int>(
                  stream: repo.latencyStream,
                  initialData: 0,
                  builder: (context, snapshot) {
                    final latency = snapshot.data ?? 0;
                    return NetworkHealthWidget(
                      latency: latency,
                      jitter: 0.5,
                      isConnected: true,
                    );
                  },
                ),
                const SizedBox(height: 24),
                const Text(
                  'Waiting for Setlist...',
                  style: TextStyle(
                    color: Colors.white38,
                    fontStyle: FontStyle.italic,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
