import 'dart:async';
import 'dart:math';

import 'package:logging/logging.dart';
import 'package:rxdart/rxdart.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:web_socket_channel/status.dart' as status;

import '../../../domain/entities/connection_status.dart';

typedef WebSocketFactory = WebSocketChannel Function(Uri uri);

class ClientEngine {
  final Logger _logger = Logger('ClientEngine');

  // Dependency Injection
  final WebSocketFactory _webSocketFactory;

  // Connection Configuration
  String? _currentUrl;
  WebSocketChannel? _channel;
  StreamSubscription? _channelSubscription;

  // State Management
  final BehaviorSubject<ConnectionStatus> _connectionStatusController =
      BehaviorSubject<ConnectionStatus>.seeded(ConnectionStatus.disconnected);

  Stream<ConnectionStatus> get connectionStatus =>
      _connectionStatusController.stream;

  ConnectionStatus get currentStatus => _connectionStatusController.value;

  // Reconnection Logic
  Timer? _reconnectTimer;
  int _reconnectAttempts = 0;
  static const int _maxReconnectDelayMs = 5000;
  static const int _baseReconnectDelayMs = 500;
  bool _isManuallyDisconnected = false;

  ClientEngine({WebSocketFactory? webSocketFactory})
      : _webSocketFactory = webSocketFactory ?? ((uri) => WebSocketChannel.connect(uri));

  /// Connects to the WebSocket server at the given [url].
  ///
  /// If already connected to the same URL, it does nothing.
  /// If connected to a different URL, it disconnects first.
  Future<void> connect(String url) async {
    if (_currentUrl == url && currentStatus == ConnectionStatus.connected) {
      _logger.info('Already connected to $url');
      return;
    }

    // Cancel any pending reconnect timer to avoid race conditions
    _reconnectTimer?.cancel();

    if (currentStatus != ConnectionStatus.disconnected) {
      await disconnect();
    }

    _currentUrl = url;
    _isManuallyDisconnected = false;
    _reconnectAttempts = 0;
    _initiateConnection();
  }

  Future<void> _initiateConnection() async {
    if (_isManuallyDisconnected || _currentUrl == null) return;

    _updateStatus(ConnectionStatus.connecting);
    _logger.info('Connecting to $_currentUrl (Attempt: $_reconnectAttempts)...');

    try {
      _channel = _webSocketFactory(Uri.parse(_currentUrl!));

      // Wait for the connection to be established if possible.
      // web_socket_channel 2.0+ has a `ready` future.
      try {
        await _channel!.ready;
      } catch (e) {
        // If ready throws, it means connection failed.
        _logger.warning('Connection failed during ready check: $e');
        _handleDisconnection();
        return;
      }

      _channelSubscription = _channel!.stream.listen(
        (message) {
          _handleMessage(message);
        },
        onError: (error) {
          _logger.severe('WebSocket Error: $error');
          _handleDisconnection();
        },
        onDone: () {
          _logger.info('WebSocket Closed');
          _handleDisconnection();
        },
        cancelOnError: true,
      );

      _handleConnected();

    } catch (e) {
      _logger.severe('Connection failed immediately: $e');
      _handleDisconnection();
    }
  }

  void _handleConnected() {
    if (currentStatus != ConnectionStatus.connected) {
      _updateStatus(ConnectionStatus.connected);
      _reconnectAttempts = 0;
      _logger.info('Connected to $_currentUrl');
    }
  }

  void _handleMessage(dynamic message) {
    // Protocol handling will go here.
    _logger.fine('Received: $message');
  }

  void _handleDisconnection() {
    _cleanupConnection();

    if (!_isManuallyDisconnected) {
      _updateStatus(ConnectionStatus.disconnected);
      _scheduleReconnect();
    } else {
      _updateStatus(ConnectionStatus.disconnected);
    }
  }

  void _cleanupConnection() {
    _channelSubscription?.cancel();
    _channelSubscription = null;
    _channel = null;
  }

  void _scheduleReconnect() {
    if (_reconnectTimer?.isActive ?? false) return;

    // Exponential backoff with jitter
    final delayMs = min(
      _maxReconnectDelayMs,
      _baseReconnectDelayMs * pow(2, _reconnectAttempts),
    );
    // Add jitter: +/- 20%
    final jitter = Random().nextInt((delayMs * 0.4).toInt()) - (delayMs * 0.2).toInt();
    final finalDelay = Duration(milliseconds: max(0, delayMs + jitter));

    _logger.info('Scheduling reconnect in ${finalDelay.inMilliseconds}ms');

    _reconnectTimer = Timer(finalDelay, () {
      _reconnectAttempts++;
      _initiateConnection();
    });
  }

  /// Disconnects gracefully.
  Future<void> disconnect() async {
    _logger.info('Disconnecting manually...');
    _isManuallyDisconnected = true;
    _reconnectTimer?.cancel();

    if (_channel != null) {
      await _channel!.sink.close(status.normalClosure);
    }

    _cleanupConnection();
    _updateStatus(ConnectionStatus.disconnected);
    _currentUrl = null;
  }

  void _updateStatus(ConnectionStatus status) {
    if (currentStatus != status) {
      _connectionStatusController.add(status);
      _logger.info('Connection Status Changed: $status');
    }
  }

  /// Send a message. Returns true if sent, false if not connected.
  bool sendMessage(dynamic message) {
    if (currentStatus == ConnectionStatus.connected && _channel != null) {
      try {
        _channel!.sink.add(message);
        return true;
      } catch (e) {
        _logger.warning('Failed to send message: $e');
        return false;
      }
    }
    return false;
  }

  void dispose() {
    disconnect();
    _connectionStatusController.close();
  }
}
