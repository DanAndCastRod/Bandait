import 'dart:async';
import 'dart:convert';
import 'dart:developer';

import 'package:injectable/injectable.dart';
import '../domain/enums/message_type.dart';
import '../domain/models/message_model.dart';
import '../domain/repositories/client_engine.dart';
import '../domain/repositories/server_engine.dart';
import '../domain/repositories/sync_service.dart';

@singleton
class DistributedMetronomeManager {
  final ClientEngine _clientEngine;
  final ServerEngine _serverEngine;
  final SyncService _syncService;

  final _startController = StreamController<int>.broadcast();
  final _stopController = StreamController<void>.broadcast();
  final _bpmController = StreamController<int>.broadcast();

  Stream<int> get onRemoteStart => _startController.stream;
  Stream<void> get onRemoteStop => _stopController.stream;
  Stream<int> get onRemoteBpmChange => _bpmController.stream;

  DistributedMetronomeManager(
    this._clientEngine,
    this._serverEngine,
    this._syncService,
  ) {
    _clientEngine.onMessage.listen(_handleMessage);
  }

  void _handleMessage(dynamic data) {
    try {
      final Map<String, dynamic> json = data is String
          ? jsonDecode(data)
          : data;
      final message = MessageModel.fromJson(json);

      switch (message.type) {
        case MessageType.startMetronome:
          final targetTime = message.payload['targetTime'] as int;
          // Local target time = targetTime (Leader Time) - Offset
          // Wait. Offset = Local - Remote.
          // Remote (Leader) = Local - Offset.
          // We have a Target Remote Time (T_remote). We want T_local.
          // T_local - Offset = T_remote
          // T_local = T_remote + Offset.
          final localTargetTime = targetTime + _syncService.currentOffsetMs;

          log(
            'Received START at $targetTime. Offset: ${_syncService.currentOffsetMs}. Local Target: $localTargetTime',
            name: 'DistMetroMgr',
          );
          _startController.add(localTargetTime);
          break;

        case MessageType.stopMetronome:
          log('Received STOP', name: 'DistMetroMgr');
          _stopController.add(null);
          break;

        case MessageType.bpmChange:
          final bpm = message.payload['bpm'] as int;
          _bpmController.add(bpm);
          break;
        default:
          break;
      }
    } catch (e) {
      log('Error handling dist message: $e', name: 'DistMetroMgr');
    }
  }

  /// Helper to send start command (Leader only)
  void sendStartCommand(int delayMs, int currentBpm) {
    // We want everyone to start at LeaderTime + delay
    final now = DateTime.now().millisecondsSinceEpoch;
    final targetTime = now + delayMs;

    final message = MessageModel(
      type: MessageType.startMetronome,
      payload: {'targetTime': targetTime},
      timestamp: now,
    );

    // Broadcast to followers
    _serverEngine.broadcast(message.toJson());

    // Also trigger local start (Leader is 0 offset to itself)
    // But we use the stream to keep it consistent?
    // Or we just return the targetTime for the caller to use?
    // Let's emit it locally too so the UI reacts same way.
    _startController.add(targetTime);
  }

  void sendStopCommand() {
    final message = MessageModel(
      type: MessageType.stopMetronome,
      payload: {},
      timestamp: DateTime.now().millisecondsSinceEpoch,
    );
    _serverEngine.broadcast(message.toJson());
    _stopController.add(null);
  }

  void sendBpmChange(int newBpm) {
    final message = MessageModel(
      type: MessageType.bpmChange,
      payload: {'bpm': newBpm},
      timestamp: DateTime.now().millisecondsSinceEpoch,
    );
    _serverEngine.broadcast(message.toJson());
    // Update local state too
    _bpmController.add(newBpm);
  }
}
