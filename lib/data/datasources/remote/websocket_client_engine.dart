import 'dart:async';
import 'dart:math';

import 'package:logging/logging.dart';
import 'package:rxdart/rxdart.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:web_socket_channel/status.dart' as status;

import '../../../domain/enums/connection_status.dart';

typedef WebSocketChannelFactory = WebSocketChannel Function(Uri uri);

class WebSocketClientEngine {
  final Logger _logger = Logger('WebSocketClientEngine');
  final WebSocketChannelFactory _channelFactory;

  // Connection Configuration
  String? _url;
  WebSocketChannel? _channel;
  StreamSubscription? _channelSubscription;

  WebSocketClientEngine({WebSocketChannelFactory? channelFactory})
      : _channelFactory = channelFactory ?? ((uri) => WebSocketChannel.connect(uri));

  // State Management
  final _connectionStatusSubject = BehaviorSubject<ConnectionStatus>.seeded(ConnectionStatus.disconnected);
  Stream<ConnectionStatus> get connectionStatus => _connectionStatusSubject.stream;
  ConnectionStatus get currentStatus => _connectionStatusSubject.value;

  // Message Stream
  final _messageSubject = PublishSubject<dynamic>();
  Stream<dynamic> get messages => _messageSubject.stream;

  // Reconnection Logic
  Timer? _reconnectTimer;
  int _retryAttempts = 0;
  static const int _maxRetryAttempts = 10;
  static const int _baseDelayMs = 1000;
  static const int _maxDelayMs = 30000;

  bool _isDisposed = false;
  bool _intentionalDisconnect = false;

  /// Connects to the given WebSocket [url].
  /// If already connected to the same URL, it does nothing.
  /// If connected to a different URL, it disconnects and connects to the new one.
  Future<void> connect(String url) async {
    if (_isDisposed) {
      _logger.warning('Attempted to connect after disposal');
      return;
    }

    if (_url == url && (currentStatus == ConnectionStatus.connected || currentStatus == ConnectionStatus.connecting)) {
      _logger.info('Already connected or connecting to $url');
      return;
    }

    _url = url;
    _intentionalDisconnect = false;
    _retryAttempts = 0;

    await _attemptConnection();
  }

  Future<void> _attemptConnection() async {
    if (_isDisposed || _intentionalDisconnect) return;

    if (_url == null) {
      _logger.severe('Cannot connect: URL is null');
      return;
    }

    _updateStatus(ConnectionStatus.connecting);
    _logger.info('Connecting to $_url...');

    try {
      // Close existing connection if any
      await _cleanupConnection();

      final uri = Uri.parse(_url!);
      _channel = _channelFactory(uri);

      _channelSubscription = _channel!.stream.listen(
        (message) {
          // If we receive a message, we are definitely connected.
          if (currentStatus != ConnectionStatus.connected) {
             _updateStatus(ConnectionStatus.connected);
             _retryAttempts = 0; // Reset retry counter on successful connection/message
             _logger.info('Connected to $_url');
          }
          _messageSubject.add(message);
        },
        onError: (error) {
          _logger.warning('WebSocket error: $error');
          _handleDisconnection();
        },
        onDone: () {
          _logger.info('WebSocket connection closed');
          _handleDisconnection();
        },
        cancelOnError: false, // We want to handle retries ourselves
      );

      // Wait a bit to ensure connection is established if no immediate message/error?
      // WebSocketChannel doesn't expose a clear "connected" future,
      // but usually if connect() doesn't throw, we are good or will get an error on stream.
      // However, for the status to flip to 'connected', we might need to assume it's connected
      // if no error occurs immediately, or wait for a handshake.
      // For now, let's assume connected if no error thrown immediately.

      // Since WebSocketChannel.connect returns immediately, we can't be sure yet.
      // But we can optimistically set it to connected or wait for the first ping?
      // Standard practice: Assume connected until stream errors/closes.
      _updateStatus(ConnectionStatus.connected);
      // NOTE: We do NOT reset _retryAttempts here. We only reset it once we receive
      // a message (proof of life) in the stream listener. This prevents infinite
      // rapid reconnection loops if the connection opens but closes immediately.

    } catch (e) {
      _logger.severe('Connection exception: $e');
      _handleDisconnection();
    }
  }

  void _handleDisconnection() {
    if (_intentionalDisconnect || _isDisposed) {
      _updateStatus(ConnectionStatus.disconnected);
      return;
    }

    if (currentStatus != ConnectionStatus.reconnecting) {
      _updateStatus(ConnectionStatus.reconnecting);
    }

    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_reconnectTimer?.isActive ?? false) return;

    // Exponential backoff with jitter
    // delay = min(cap, base * 2 ^ attempt)
    final delay = min(
      _maxDelayMs,
      _baseDelayMs * pow(2, _retryAttempts),
    ).toInt();

    // Add jitter (randomness) to avoid thundering herd
    final jitter = Random().nextInt(1000);
    final totalDelay = delay + jitter;

    _logger.info('Scheduling reconnection attempt ${_retryAttempts + 1} in ${totalDelay}ms');

    _reconnectTimer = Timer(Duration(milliseconds: totalDelay), () {
      _retryAttempts++;
      _attemptConnection();
    });
  }

  Future<void> disconnect() async {
    _logger.info('Disconnecting...');
    _intentionalDisconnect = true;
    _reconnectTimer?.cancel();
    await _cleanupConnection();
    _updateStatus(ConnectionStatus.disconnected);
  }

  Future<void> _cleanupConnection() async {
    await _channelSubscription?.cancel();
    _channelSubscription = null;

    if (_channel != null) {
      await _channel!.sink.close(status.goingAway);
      _channel = null;
    }
  }

  void send(dynamic message) {
    if (currentStatus == ConnectionStatus.connected && _channel != null) {
      try {
        _channel!.sink.add(message);
      } catch (e) {
        _logger.warning('Failed to send message: $e');
        // If send fails, it might mean connection is broken
        _handleDisconnection();
      }
    } else {
      _logger.warning('Cannot send message: Not connected');
    }
  }

  void _updateStatus(ConnectionStatus status) {
    if (_connectionStatusSubject.isClosed) return;

    if (_connectionStatusSubject.value != status) {
      _connectionStatusSubject.add(status);
      _logger.fine('Connection status changed: $status');
    }
  }

  void dispose() {
    _isDisposed = true;
    disconnect();
    _connectionStatusSubject.close();
    _messageSubject.close();
  }
}
