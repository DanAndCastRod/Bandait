import 'package:flutter/material.dart';
import 'package:bandait/core/di/injection.dart';
import 'package:bandait/domain/models/user_profile.dart';
import 'package:bandait/domain/repositories/session_repository.dart';
import 'package:bandait/presentation/theme/app_theme.dart';
import 'package:bandait/presentation/pages/connect/leader_lobby_page.dart';
import 'package:bandait/presentation/pages/connect/join_session_page.dart';
import 'package:bandait/presentation/pages/library/song_library_page.dart';
import 'package:bandait/presentation/pages/library/setlist_library_page.dart';
import 'package:bandait/presentation/pages/metronome_page.dart';
import 'package:bandait/presentation/pages/audio_settings/audio_settings_screen.dart';

class ProfileSelectionPage extends StatefulWidget {
  const ProfileSelectionPage({super.key});

  @override
  State<ProfileSelectionPage> createState() => _ProfileSelectionPageState();
}

class _ProfileSelectionPageState extends State<ProfileSelectionPage> {
  final _sessionRepo = getIt<SessionRepository>();
  UserProfile? _currentProfile;
  bool _isLoading = true;

  final _nameController = TextEditingController();
  String _selectedInstrument = 'guitar';
  // Simple color picker choices
  final List<Color> _colors = [
    Colors.blue,
    Colors.red,
    Colors.green,
    Colors.purple,
    Colors.orange,
    Colors.teal,
  ];
  int _selectedColorIndex = 0;

  @override
  void initState() {
    super.initState();
    _checkProfile();
  }

  Future<void> _checkProfile() async {
    // We assume init happened in main
    final profile = await _sessionRepo.getUserProfile();
    setState(() {
      _currentProfile = profile;
      _isLoading = false;
      if (profile != null) {
        _nameController.text = profile.name;
        _selectedInstrument = profile.instrument;
        // find color index
        final colorVal = profile.colorValue;
        final idx = _colors.indexWhere((c) => c.value == colorVal);
        _selectedColorIndex = idx != -1 ? idx : 0;
      }
    });
  }

  Future<void> _saveProfile() async {
    if (_nameController.text.trim().isEmpty) return;

    final profile = UserProfile(
      id: DateTime.now().millisecondsSinceEpoch.toString(),
      name: _nameController.text.trim(),
      instrument: _selectedInstrument,
      colorValue: _colors[_selectedColorIndex].value,
    );

    await _sessionRepo.saveUserProfile(profile);
    setState(() => _currentProfile = profile);
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading)
      return const Scaffold(body: Center(child: CircularProgressIndicator()));

    // if (_currentProfile == null) {
    //   return _buildSetupForm();
    // }
    // Actually simpler: Always show profile header, allow edit.
    // Below show "Start Session" or "Join Session".

    return Scaffold(
      backgroundColor: AppTheme.darkBackground,
      appBar: AppBar(title: const Text('BANDAIT IDENTITY'), centerTitle: true),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _buildProfileSection(),
            const SizedBox(height: 48),
            if (_currentProfile != null) ...[
              const Text(
                'READY TO ROCK?',
                style: TextStyle(color: Colors.grey, letterSpacing: 2),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 24),
              _buildRoleButton(
                title: 'HOST SESSION',
                subtitle: 'I am the Leader',
                icon: Icons.speaker_group,
                color: AppTheme.primaryColor,
                onTap: () {
                  if (_currentProfile != null) {
                    Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (_) =>
                            LeaderLobbyPage(userProfile: _currentProfile!),
                      ),
                    );
                  }
                },
              ),
              const SizedBox(height: 16),
              _buildRoleButton(
                title: 'JOIN BAND',
                subtitle: 'Looking for a session',
                icon: Icons.link,
                color: Colors.blue,
                onTap: () {
                  if (_currentProfile != null) {
                    Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (_) =>
                            JoinSessionPage(userProfile: _currentProfile!),
                      ),
                    );
                  }
                },
              ),
              const SizedBox(height: 32),
              const Divider(color: Colors.white24),
              const SizedBox(height: 16),

              // DASHBOARD CONTENT
              _buildSectionHeader('LIBRARY', Icons.library_music),
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: _buildFeatureCard(
                      title: 'SONGS',
                      icon: Icons.music_note,
                      color: Colors.purple,
                      onTap: () => Navigator.push(
                        context,
                        MaterialPageRoute(
                          builder: (_) => const SongLibraryPage(),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: _buildFeatureCard(
                      title: 'SETLISTS',
                      icon: Icons.playlist_play,
                      color: Colors.indigo,
                      onTap: () => Navigator.push(
                        context,
                        MaterialPageRoute(
                          builder: (_) => const SetlistLibraryPage(),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 24),
              _buildSectionHeader('TOOLS', Icons.build),
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: _buildFeatureCard(
                      title: 'METRONOME',
                      icon: Icons.timer,
                      color: Colors.teal,
                      // Solo practice mode (no forceLeader, defaults to true)
                      onTap: () => Navigator.push(
                        context,
                        MaterialPageRoute(
                          builder: (_) => const MetronomePage(),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: _buildFeatureCard(
                      title: 'AUDIO',
                      icon: Icons.settings,
                      color: Colors.blueGrey,
                      onTap: () => Navigator.push(
                        context,
                        MaterialPageRoute(
                          builder: (_) => const AudioSettingsScreen(),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ],
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

  Widget _buildFeatureCard({
    required String title,
    required IconData icon,
    required Color color,
    required VoidCallback onTap,
  }) {
    return Material(
      color: AppTheme.cardBackground,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: Colors.white10),
          ),
          child: Column(
            children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  color: color.withOpacity(0.2),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Icon(icon, color: color, size: 28),
              ),
              const SizedBox(height: 12),
              Text(
                title,
                style: const TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.bold,
                  fontSize: 12,
                  letterSpacing: 1,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildProfileSection() {
    // ... existing _buildProfileSection
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppTheme.cardBackground,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.white10),
      ),
      child: Column(
        children: [
          TextField(
            controller: _nameController,
            style: const TextStyle(
              color: Colors.white,
              fontSize: 18,
              fontWeight: FontWeight.bold,
            ),
            decoration: const InputDecoration(
              labelText: 'YOUR NAME',
              labelStyle: TextStyle(color: Colors.grey),
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 16),
          DropdownButtonFormField<String>(
            value: _selectedInstrument,
            dropdownColor: AppTheme.cardBackground,
            items: ['guitar', 'drums', 'bass', 'vocals', 'keys', 'tech']
                .map(
                  (i) => DropdownMenuItem(
                    value: i,
                    child: Text(
                      i.toUpperCase(),
                      style: const TextStyle(color: Colors.white),
                    ),
                  ),
                )
                .toList(),
            onChanged: (val) => setState(() => _selectedInstrument = val!),
            decoration: const InputDecoration(
              labelText: 'INSTRUMENT',
              labelStyle: TextStyle(color: Colors.grey),
            ),
          ),
          const SizedBox(height: 16),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: List.generate(_colors.length, (index) {
              final isSelected = index == _selectedColorIndex;
              return GestureDetector(
                onTap: () => setState(() => _selectedColorIndex = index),
                child: Container(
                  margin: const EdgeInsets.symmetric(horizontal: 4),
                  width: 32,
                  height: 32,
                  decoration: BoxDecoration(
                    color: _colors[index],
                    shape: BoxShape.circle,
                    border: isSelected
                        ? Border.all(color: Colors.white, width: 3)
                        : null,
                  ),
                ),
              );
            }),
          ),
          const SizedBox(height: 24),
          ElevatedButton(
            onPressed: _saveProfile,
            style: ElevatedButton.styleFrom(backgroundColor: Colors.white10),
            child: const Text('UPDATE PROFILE'),
          ),
        ],
      ),
    );
  }

  Widget _buildRoleButton({
    required String title,
    required String subtitle,
    required IconData icon,
    required Color color,
    required VoidCallback onTap,
  }) {
    return Material(
      color: AppTheme.cardBackground,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Row(
            children: [
              Icon(icon, size: 40, color: color),
              const SizedBox(width: 24),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: TextStyle(
                      color: color,
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  Text(subtitle, style: const TextStyle(color: Colors.grey)),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
