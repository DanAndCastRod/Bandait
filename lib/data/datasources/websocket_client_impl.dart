import 'dart:async';
import 'dart:convert';
import 'dart:developer';
import 'dart:io';

import 'package:injectable/injectable.dart';
import '../../domain/enums/connection_status.dart';
import '../../domain/repositories/client_engine.dart';

@Singleton(as: ClientEngine)
class WebSocketClientImpl implements ClientEngine {
  WebSocket? _socket;
  final _messageController = StreamController<dynamic>.broadcast();
  final _statusController = StreamController<ConnectionStatus>.broadcast();

  ConnectionStatus _currentStatus = ConnectionStatus.disconnected;

  // Reconnection variables
  Timer? _reconnectTimer;
  String? _lastIp;
  int? _lastPort;
  int _retryCount = 0;
  static const int _maxRetries = 5;

  @override
  Stream<dynamic> get onMessage => _messageController.stream;

  @override
  Stream<ConnectionStatus> get onStatusChanged => _statusController.stream;

  @override
  ConnectionStatus get currentStatus => _currentStatus;

  void _updateStatus(ConnectionStatus status) {
    _currentStatus = status;
    _statusController.add(status);
    log('Client status: $status', name: 'WebSocketClientImpl');
  }

  @override
  Future<void> connect(String ip, int port) async {
    _lastIp = ip;
    _lastPort = port;
    _retryCount = 0;
    await _connect();
  }

  Future<void> _connect() async {
    if (_lastIp == null || _lastPort == null) return;

    try {
      _updateStatus(ConnectionStatus.connecting);
      final url = 'ws://$_lastIp:$_lastPort';
      log('Attempting connection to $url', name: 'WebSocketClientImpl');

      _socket = await WebSocket.connect(url);
      _updateStatus(ConnectionStatus.connected);
      _retryCount = 0;
      _reconnectTimer?.cancel();

      _socket!.listen(
        (data) {
          _messageController.add(data);
        },
        onDone: () {
          log('Connection closed by server', name: 'WebSocketClientImpl');
          _handleDisconnection();
        },
        onError: (error) {
          log(
            'Connection error: $error',
            name: 'WebSocketClientImpl',
            error: error,
          );
          _handleDisconnection();
        },
      );
    } catch (e) {
      log('Connection failed: $e', name: 'WebSocketClientImpl');
      _handleDisconnection();
    }
  }

  void _handleDisconnection() {
    _socket = null;
    if (_currentStatus != ConnectionStatus.disconnected) {
      // Only try to reconnect if we were previously trying to connect or connected
      // and we haven't manually disconnected.
      _attemptReconnect();
    }
  }

  void _attemptReconnect() {
    if (_retryCount >= _maxRetries) {
      _updateStatus(ConnectionStatus.error);
      log('Max retries reached. Giving up.', name: 'WebSocketClientImpl');
      return;
    }

    _updateStatus(ConnectionStatus.reconnecting);
    final delay = Duration(
      milliseconds: 500 * (1 << _retryCount),
    ); // Exponential backoff
    _retryCount++;
    log(
      'Reconnecting in ${delay.inMilliseconds}ms (Attempt $_retryCount)',
      name: 'WebSocketClientImpl',
    );

    _reconnectTimer = Timer(delay, _connect);
  }

  @override
  Future<void> disconnect() async {
    _reconnectTimer?.cancel();
    _lastIp = null; // Clear config to prevent auto-reconnect
    await _socket?.close();
    _socket = null;
    _updateStatus(ConnectionStatus.disconnected);
  }

  @override
  void send(Map<String, dynamic> data) {
    if (_socket?.readyState == WebSocket.open) {
      _socket!.add(jsonEncode(data));
    } else {
      log('Cannot send: Socket not open', name: 'WebSocketClientImpl');
    }
  }
}
