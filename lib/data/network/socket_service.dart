import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter/foundation.dart';
import 'package:bandait/core/di/injection.dart';
import 'package:bandait/data/network/clock_service.dart';

class SocketServer {
  ServerSocket? _serverSocket;
  final List<Socket> _clients = [];
  final _onDataReceivedController = StreamController<NetworkEvent>.broadcast();
  final _onClientConnectedController = StreamController<String>.broadcast();
  final _onClientDisconnectedController = StreamController<String>.broadcast();

  Stream<NetworkEvent> get onDataReceived => _onDataReceivedController.stream;
  Stream<String> get onClientConnected => _onClientConnectedController.stream;
  Stream<String> get onClientDisconnected =>
      _onClientDisconnectedController.stream;

  int get port => _serverSocket?.port ?? 0;

  Future<void> start(int port) async {
    await stop();
    _serverSocket = await ServerSocket.bind(InternetAddress.anyIPv4, port);
    debugPrint('SocketServer listening on port $port');

    _serverSocket!.listen((socket) {
      _handleConnection(socket);
    }, onError: (e) => debugPrint('SocketServer Error: $e'));
  }

  void _handleConnection(Socket socket) {
    debugPrint('New Client Connected: ${socket.remoteAddress.address}');
    _clients.add(socket);
    _onClientConnectedController.add(socket.remoteAddress.address);

    socket.listen(
      (data) {
        try {
          final message = String.fromCharCodes(data).trim();
          if (message == 'PING') {
            socket.write('PONG');
          } else if (message.startsWith('SYNC_REQ')) {
            // Client sent SYNC_REQ|t1
            final parts = message.split('|');
            if (parts.length == 2) {
              final t1 = parts[1];
              final t2 = DateTime.now().millisecondsSinceEpoch;
              final t3 = t2; // Assume negligible processing time for now
              socket.write('SYNC_RESP|$t1|$t2|$t3');
            }
          } else {
            _onDataReceivedController.add(
              NetworkEvent(socket.remoteAddress.address, message),
            );
          }
        } catch (e) {
          debugPrint('Error parsing data: $e');
        }
      },
      onError: (e) {
        debugPrint('Client Socket Error: $e');
        _removeClient(socket);
      },
      onDone: () {
        debugPrint('Client Disconnected');
        _removeClient(socket);
      },
    );
  }

  void _removeClient(Socket socket) {
    _clients.remove(socket);
    _onClientDisconnectedController.add(socket.remoteAddress.address);
    socket.destroy();
  }

  void broadcast(String message) {
    // Iterate over a snapshot to avoid concurrent modification if a client disconnects during broadcast
    for (final client in [..._clients]) {
      try {
        client.write(message);
      } catch (e) {
        debugPrint('Error broadcasting to client: $e');
      }
    }
  }

  Future<void> stop() async {
    final clientsSnapshot = [..._clients];
    _clients.clear();
    for (final client in clientsSnapshot) {
      client.destroy();
    }
    await _serverSocket?.close();
    _serverSocket = null;
  }
}

class SocketClient {
  Socket? _socket;
  final _onDataReceivedController = StreamController<String>.broadcast();
  final _onConnectionStatusChangedController =
      StreamController<bool>.broadcast();
  final _latencyController = StreamController<int>.broadcast();

  Timer? _heartbeatTimer;
  int _lastPingTime = 0;

  Stream<String> get onDataReceived => _onDataReceivedController.stream;
  Stream<bool> get onConnectionStatusChanged =>
      _onConnectionStatusChangedController.stream;
  Stream<int> get latencyStream => _latencyController.stream;

  bool get isConnected => _socket != null;

  Future<void> connect(String host, int port) async {
    await disconnect();
    try {
      _socket = await Socket.connect(
        host,
        port,
        timeout: const Duration(seconds: 5),
      );
      _onConnectionStatusChangedController.add(true);
      debugPrint('Connected to $host:$port');

      _startHeartbeat();

      _socket!.listen(
        (data) {
          final message = String.fromCharCodes(data).trim();
          if (message == 'PONG') {
            final rtt = DateTime.now().millisecondsSinceEpoch - _lastPingTime;
            // debugPrint('RTT: ${rtt}ms');
            _latencyController.add(rtt);
          } else if (message.startsWith('SYNC_RESP')) {
            final parts = message.split('|');
            if (parts.length == 4) {
              final t1 = int.parse(parts[1]);
              final t2 = int.parse(parts[2]);
              final t3 = int.parse(parts[3]);
              final t4 = DateTime.now().millisecondsSinceEpoch;
              getIt<ClockService>().handleSyncResponse(t1, t2, t3, t4);
            }
          } else if (message.startsWith('START_METRONOME')) {
            final parts = message.split('|');
            if (parts.length == 3) {
              final bpm = double.parse(parts[1]);
              final startTime = int.parse(parts[2]);
              getIt<ClockService>().startMetronome(bpm, startTime);
            }
          } else if (message == 'STOP_METRONOME') {
            getIt<ClockService>().stopMetronome();
          } else {
            _onDataReceivedController.add(message);
          }
        },
        onError: (e) {
          debugPrint('SocketClient Error: $e');
          disconnect();
        },
        onDone: () {
          debugPrint('Server disconnected');
          disconnect();
        },
      );
    } catch (e) {
      debugPrint('Connection Failed: $e');
      rethrow;
    }
  }

  void sync() {
    final t1 = DateTime.now().millisecondsSinceEpoch;
    send('SYNC_REQ|$t1');
  }

  void _startHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (isConnected) {
        ping();
      }
    });
  }

  void ping() {
    _lastPingTime = DateTime.now().millisecondsSinceEpoch;
    send('PING');
  }

  void send(String message) {
    try {
      _socket?.write(message);
    } catch (e) {
      debugPrint('Send Error: $e');
    }
  }

  Future<void> disconnect() async {
    _heartbeatTimer?.cancel();
    if (_socket != null) {
      _onConnectionStatusChangedController.add(false);
      await _socket!.close();
      _socket = null;
    }
  }
}

class NetworkEvent {
  final String sender;
  final String message;
  NetworkEvent(this.sender, this.message);
}
