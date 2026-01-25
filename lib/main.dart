import 'dart:io';

import 'package:flutter/material.dart';
import 'package:bandait/core/di/injection.dart';
import 'package:bandait/domain/repositories/server_engine.dart';
import 'package:bandait/domain/repositories/client_engine.dart';
import 'package:bandait/domain/repositories/audio_engine.dart';

import 'package:bandait/presentation/pages/debug_sync_page.dart';
import 'package:bandait/presentation/pages/debug_audio_page.dart';
import 'package:bandait/presentation/pages/metronome_page.dart';
import 'package:bandait/presentation/pages/library/song_library_page.dart';
import 'package:bandait/presentation/pages/library/setlist_library_page.dart';
import 'package:bandait/presentation/pages/audio_settings/audio_settings_screen.dart';

import 'package:hive_flutter/hive_flutter.dart';
import 'package:bandait/domain/models/song.dart';
import 'package:bandait/domain/models/user_profile.dart';
import 'package:bandait/presentation/theme/app_theme.dart';
import 'package:bandait/presentation/pages/profile_selection_page.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  await Hive.initFlutter();
  // Register Hive Adapters
  Hive.registerAdapter(SongImplAdapter());
  Hive.registerAdapter(LyricLineImplAdapter());
  Hive.registerAdapter(UserProfileImplAdapter());

  configureDependencies();

  // Initialize Audio Engine
  try {
    await getIt<AudioEngine>().initialize();
  } catch (e) {
    debugPrint('Failed to initialize AudioEngine: $e');
  }

  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Bandait',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.darkTheme,
      home: const ProfileSelectionPage(),
    );
  }
}

class RoleSelectionPage extends StatefulWidget {
  const RoleSelectionPage({super.key});

  @override
  State<RoleSelectionPage> createState() => _RoleSelectionPageState();
}

class _RoleSelectionPageState extends State<RoleSelectionPage> {
  final TextEditingController _ipController = TextEditingController(
    text: '192.168.1.5',
  );
  bool _isLeader = false;
  bool _isConnecting = false;

  @override
  void initState() {
    super.initState();
    _findLocalIp();
  }

  Future<void> _findLocalIp() async {
    try {
      for (var interface in await NetworkInterface.list()) {
        for (var addr in interface.addresses) {
          if (addr.type == InternetAddressType.IPv4 && !addr.isLoopback) {
            setState(() => _ipController.text = addr.address);
            return;
          }
        }
      }
    } catch (_) {}
  }

  void _startAsLeader() async {
    setState(() => _isConnecting = true);
    try {
      final server = getIt<ServerEngine>();
      await server.start(port: 4040);
      setState(() => _isLeader = true);
      if (!mounted) return;
      Navigator.push(
        context,
        MaterialPageRoute(builder: (_) => const DebugSyncPage(isLeader: true)),
      );
    } catch (e) {
      _showError('Failed to start server: $e');
    } finally {
      if (mounted) setState(() => _isConnecting = false);
    }
  }

  void _startAsFollower() async {
    setState(() => _isConnecting = true);
    try {
      final client = getIt<ClientEngine>();
      await client.connect(_ipController.text, 4040);
      setState(() => _isLeader = false);
      if (!mounted) return;
      Navigator.push(
        context,
        MaterialPageRoute(builder: (_) => const DebugSyncPage(isLeader: false)),
      );
    } catch (e) {
      _showError('Failed to connect: $e');
    } finally {
      if (mounted) setState(() => _isConnecting = false);
    }
  }

  void _showError(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: Colors.red[800]),
    );
  }

  void _navigateTo(Widget page) {
    Navigator.push(context, MaterialPageRoute(builder: (_) => page));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.darkBackground,
      appBar: AppBar(
        title: const Text(
          'BANDAIT',
          style: TextStyle(fontWeight: FontWeight.bold, letterSpacing: 3),
        ),
        centerTitle: true,
        backgroundColor: Colors.transparent,
        elevation: 0,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // ===== NETWORK SECTION =====
            _buildSectionHeader('CONEXIÓN DE RED', Icons.wifi),
            const SizedBox(height: 16),
            _buildRoleButton(
              label: 'INICIAR COMO LÍDER',
              subtitle: 'Servidor • Controla la sesión',
              icon: Icons.star,
              color: AppTheme.primaryColor,
              onTap: _isConnecting ? null : _startAsLeader,
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _ipController,
              decoration: InputDecoration(
                labelText: 'IP del Líder',
                labelStyle: TextStyle(color: Colors.grey[500]),
                prefixIcon: Icon(Icons.lan, color: Colors.grey[600]),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: BorderSide(color: Colors.grey[800]!),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: BorderSide(color: Colors.grey[800]!),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: const BorderSide(color: AppTheme.primaryColor),
                ),
                filled: true,
                fillColor: AppTheme.cardBackground,
              ),
              style: const TextStyle(
                color: Colors.white,
                fontFamily: 'monospace',
              ),
            ),
            const SizedBox(height: 12),
            _buildRoleButton(
              label: 'UNIRSE COMO SEGUIDOR',
              subtitle: 'Cliente • Recibe sincronización',
              icon: Icons.group,
              color: Colors.blueGrey,
              onTap: _isConnecting ? null : _startAsFollower,
            ),
            if (_isConnecting)
              const Padding(
                padding: EdgeInsets.only(top: 16),
                child: Center(
                  child: CircularProgressIndicator(
                    color: AppTheme.primaryColor,
                  ),
                ),
              ),

            const SizedBox(height: 32),

            // ===== CONTENT SECTION =====
            _buildSectionHeader('CONTENIDO', Icons.library_music),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: _buildFeatureCard(
                    title: 'CANCIONES',
                    icon: Icons.music_note,
                    color: Colors.purple,
                    onTap: () => _navigateTo(const SongLibraryPage()),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _buildFeatureCard(
                    title: 'SETLISTS',
                    icon: Icons.playlist_play,
                    color: Colors.indigo,
                    onTap: () => _navigateTo(const SetlistLibraryPage()),
                  ),
                ),
              ],
            ),

            const SizedBox(height: 32),

            // ===== TOOLS SECTION =====
            _buildSectionHeader('HERRAMIENTAS', Icons.build),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: _buildFeatureCard(
                    title: 'METRÓNOMO',
                    icon: Icons.timer,
                    color: Colors.teal,
                    onTap: () =>
                        _navigateTo(MetronomePage(isLeader: _isLeader)),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _buildFeatureCard(
                    title: 'AUDIO',
                    icon: Icons.settings,
                    color: Colors.blueGrey,
                    onTap: () => _navigateTo(const AudioSettingsScreen()),
                  ),
                ),
              ],
            ),

            const SizedBox(height: 32),

            // ===== DEBUG SECTION =====
            _buildSectionHeader('DEBUG', Icons.bug_report),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: _buildFeatureCard(
                    title: 'SYNC TEST',
                    icon: Icons.sync,
                    color: Colors.deepPurple,
                    onTap: () => _navigateTo(const DebugAudioPage()),
                    small: true,
                  ),
                ),
              ],
            ),

            const SizedBox(height: 40),
          ],
        ),
      ),
    );
  }

  Widget _buildSectionHeader(String title, IconData icon) {
    return Row(
      children: [
        Icon(icon, color: Colors.grey[600], size: 18),
        const SizedBox(width: 8),
        Text(
          title,
          style: TextStyle(
            color: Colors.grey[500],
            fontSize: 12,
            fontWeight: FontWeight.bold,
            letterSpacing: 2,
          ),
        ),
      ],
    );
  }

  Widget _buildRoleButton({
    required String label,
    required String subtitle,
    required IconData icon,
    required Color color,
    VoidCallback? onTap,
  }) {
    return Material(
      color: AppTheme.cardBackground,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: color.withOpacity(0.3)),
          ),
          child: Row(
            children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  color: color.withOpacity(0.2),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(icon, color: color),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      label,
                      style: TextStyle(
                        color: color,
                        fontWeight: FontWeight.bold,
                        fontSize: 14,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      subtitle,
                      style: TextStyle(color: Colors.grey[600], fontSize: 12),
                    ),
                  ],
                ),
              ),
              Icon(Icons.chevron_right, color: Colors.grey[700]),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildFeatureCard({
    required String title,
    required IconData icon,
    required Color color,
    required VoidCallback onTap,
    bool small = false,
  }) {
    return Material(
      color: AppTheme.cardBackground,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Container(
          padding: EdgeInsets.all(small ? 16 : 20),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: Colors.white10),
          ),
          child: Column(
            children: [
              Container(
                width: small ? 40 : 56,
                height: small ? 40 : 56,
                decoration: BoxDecoration(
                  color: color.withOpacity(0.2),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Icon(icon, color: color, size: small ? 24 : 28),
              ),
              const SizedBox(height: 12),
              Text(
                title,
                style: TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.bold,
                  fontSize: small ? 11 : 12,
                  letterSpacing: 1,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
