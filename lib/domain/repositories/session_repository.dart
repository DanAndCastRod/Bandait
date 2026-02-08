import 'package:bandait/domain/models/user_profile.dart';

class BandSession {
  final String name;
  final String host; // IP
  final int port;

  BandSession({required this.name, required this.host, required this.port});
}

abstract class SessionRepository {
  /// Starts broadcasting this device as a Bandait Server (Leader).
  Future<void> startHosting({required String sessionName, required int port});

  /// Stops broadcasting.
  Future<void> stopHosting();

  /// Starts looking for other Bandait Servers (Follower).
  Future<void> startDiscovery();

  /// Stops looking.
  Future<void> stopDiscovery();

  /// Connect to a specific host (handshake).
  Future<void> connectTo(String host, int port);

  /// Stream of discovered sessions (mDNS).
  Stream<List<BandSession>> get discoveredSessions;

  /// Stream of connected peers (TCP Handshake confirmed).
  Stream<List<String>> get connectedPeers;

  /// Stream of latency (RTT) in milliseconds.
  Stream<int> get latencyStream;

  /// Stream of panic events (true = panic active).
  Stream<bool> get panicStream;

  /// Broadcasts a panic signal to all connected peers.
  void sendPanic();

  /// Starts the global metronome.
  void startMetronome(double bpm);

  /// Stops the global metronome.
  void stopMetronome();

  /// Saves the local user profile.
  Future<void> saveUserProfile(UserProfile profile);

  /// Gets the local user profile.
  Future<UserProfile?> getUserProfile();

  // --- Role State ---
  /// Stream indicating if this device is the session Leader.
  Stream<bool> get isLeaderStream;

  /// Synchronous getter for current leader state.
  bool get isLeader;

  // --- Content Sharing ---
  /// Broadcasts a setlist JSON to all connected peers (Leader only).
  void broadcastSetlist(Map<String, dynamic> setlistJson);

  /// Stream of setlists received from the Leader (Follower only).
  Stream<Map<String, dynamic>> get onSetlistReceived;
}
