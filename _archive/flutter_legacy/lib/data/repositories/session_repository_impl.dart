import 'dart:async';
import 'package:nsd/nsd.dart' as nsd;
import 'package:injectable/injectable.dart';
import 'package:hive/hive.dart';
import 'package:bandait/domain/repositories/session_repository.dart';
import 'package:bandait/domain/models/user_profile.dart';
import 'package:bandait/data/network/socket_service.dart';
import 'package:bandait/core/di/injection.dart';
import 'package:bandait/data/network/clock_service.dart';

@LazySingleton(as: SessionRepository)
class SessionRepositoryImpl implements SessionRepository {
  // NSD
  nsd.Discovery? _discovery;
  nsd.Registration? _registration;
  final _sessionsController = StreamController<List<BandSession>>.broadcast();
  final List<BandSession> _currentSessions = [];

  // TCP
  final SocketServer _socketServer = SocketServer();
  final SocketClient _socketClient = SocketClient();
  final _peersController = StreamController<List<String>>.broadcast();
  final List<String> _connectedPeers = [];
  final _panicController = StreamController<bool>.broadcast();

  // Role State
  final _isLeaderController = StreamController<bool>.broadcast();
  bool _isLeader = false;

  // Content Sharing
  final _setlistReceivedController =
      StreamController<Map<String, dynamic>>.broadcast();

  // ... (Constructor remains)

  @override
  Stream<bool> get panicStream => _panicController.stream;

  @override
  void sendPanic() {
    // If hosting, broadcast to all
    if (_socketServer.port != 0) {
      // Check if server running
      _socketServer.broadcast('PANIC');
      _panicController.add(true); // Local UI update
    }
  }

  @override
  void startMetronome(double bpm) {
    if (_socketServer.port != 0) {
      final startTime = getIt<ClockService>().now() + 500; // 500ms delay
      _socketServer.broadcast('START_METRONOME|$bpm|$startTime');
      getIt<ClockService>().startMetronome(bpm, startTime);
    }
  }

  @override
  void stopMetronome() {
    if (_socketServer.port != 0) {
      _socketServer.broadcast('STOP_METRONOME');
      getIt<ClockService>().stopMetronome();
    }
  }

  // ...

  @override
  Future<void> connectTo(String host, int port) async {
    await _socketClient.connect(host, port);

    // Set role to Follower
    _isLeader = false;
    _isLeaderController.add(false);

    // Listen for PANIC and SETLIST
    _socketClient.onDataReceived.listen((msg) {
      if (msg == 'PANIC') {
        _panicController.add(true);
      } else if (msg.startsWith('SYNC_SETLIST|')) {
        try {
          final jsonStr = msg.substring('SYNC_SETLIST|'.length);
          final jsonData = Map<String, dynamic>.from(
            Uri.decodeFull(jsonStr).isNotEmpty
                ? (throw 'Use dart:convert')
                : {},
          );
          _setlistReceivedController.add(jsonData);
        } catch (_) {
          // Handle JSON parse issues later
        }
      }
    });

    // Start Clock Sync
    _socketClient.sync();

    // Send HELLO packet
    final profile = await getUserProfile();
    if (profile != null) {
      _socketClient.send('HELLO|${profile.name}|${profile.instrument}');
    } else {
      _socketClient.send('HELLO|Unknown|Guest');
    }
  }

  static const String _serviceType = '_bandait._tcp';
  static const String _profileBoxName = 'user_profile_box';

  SessionRepositoryImpl() {
    _socketServer.onClientConnected.listen((peer) {
      _connectedPeers.add(peer);
      _peersController.add(List.from(_connectedPeers));
    });

    _socketServer.onClientDisconnected.listen((peer) {
      _connectedPeers.remove(peer);
      _peersController.add(List.from(_connectedPeers));
    });
  }

  @override
  Stream<List<BandSession>> get discoveredSessions =>
      _sessionsController.stream;

  @override
  Stream<List<String>> get connectedPeers => _peersController.stream;

  @override
  Stream<int> get latencyStream => _socketClient.latencyStream;

  @override
  int get activePort => _socketServer.port;

  @override
  Future<void> startHosting({
    required String sessionName,
    required int port,
  }) async {
    await stopHosting();

    // Set role to Leader
    _isLeader = true;
    _isLeaderController.add(true);

    // 1. Start TCP Server (might fallback to a different port)
    await _socketServer.start(port);

    // 2. Broadcast Service
    try {
      _registration = await nsd.register(
        nsd.Service(name: sessionName, type: _serviceType, port: activePort),
      );
    } catch (e) {
      // Allow TCP to continue running even if mDNS discovery fails due to Android quirks
      print('Warning: NSD Registration failed - $e');
      _registration = null;
    }
  }

  @override
  Future<void> stopHosting() async {
    await _socketServer.stop();
    if (_registration != null) {
      await nsd.unregister(_registration!);
      _registration = null;
    }
    // Reset role
    _isLeader = false;
    _isLeaderController.add(false);
  }

  @override
  Future<void> startDiscovery() async {
    await stopDiscovery();
    _discovery = await nsd.startDiscovery(_serviceType, autoResolve: true);
    _discovery!.addServiceListener((service, status) {
      if (status == nsd.ServiceStatus.found) {
        _addSession(service);
      } else {
        _removeSession(service);
      }
    });
  }

  @override
  Future<void> stopDiscovery() async {
    if (_discovery != null) {
      await nsd.stopDiscovery(_discovery!);
      _discovery = null;
      _currentSessions.clear();
      _sessionsController.add([]);
    }
  }

  void _addSession(nsd.Service service) {
    if (_currentSessions.any((s) => s.name == service.name)) return;
    if (service.host != null) {
      _currentSessions.add(
        BandSession(
          name: service.name ?? 'Unknown',
          host: service.host!,
          port: service.port ?? 0,
        ),
      );
      _sessionsController.add(List.from(_currentSessions));
    }
  }

  void _removeSession(nsd.Service service) {
    _currentSessions.removeWhere((s) => s.name == service.name);
    _sessionsController.add(List.from(_currentSessions));
  }

  // --- Profile Management ---

  @override
  Future<void> saveUserProfile(UserProfile profile) async {
    final box = await Hive.openBox<UserProfile>(_profileBoxName);
    await box.put('current', profile);
  }

  @override
  Future<UserProfile?> getUserProfile() async {
    if (!Hive.isAdapterRegistered(4)) return null;
    final box = await Hive.openBox<UserProfile>(_profileBoxName);
    return box.get('current');
  }

  // --- Role State Implementation ---
  @override
  Stream<bool> get isLeaderStream => _isLeaderController.stream;

  @override
  bool get isLeader => _isLeader;

  // --- Content Sharing Implementation ---
  @override
  void broadcastSetlist(Map<String, dynamic> setlistJson) {
    if (_isLeader) {
      // Use simple JSON encoding. Ensure no | in the JSON.
      final jsonStr = Uri.encodeComponent(setlistJson.toString());
      _socketServer.broadcast('SYNC_SETLIST|$jsonStr');
    }
  }

  @override
  Stream<Map<String, dynamic>> get onSetlistReceived =>
      _setlistReceivedController.stream;
}
