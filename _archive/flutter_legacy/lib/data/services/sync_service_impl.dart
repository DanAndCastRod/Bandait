import 'dart:async';
import 'dart:convert';
import 'dart:developer';

import 'package:injectable/injectable.dart';
import '../../domain/enums/message_type.dart';
import '../../domain/models/message_model.dart';
import '../../domain/models/sync_result.dart';
import '../../domain/repositories/client_engine.dart';
import '../../domain/repositories/sync_service.dart';

@Singleton(as: SyncService)
class SyncServiceImpl implements SyncService {
  final ClientEngine _clientEngine;

  final _syncUpdateController = StreamController<SyncResult>.broadcast();
  final List<SyncResult> _samples = [];
  static const int _maxSamples = 10;

  Timer? _periodicTimer;
  Completer<Map<String, dynamic>>? _pendingSyncCompleter;
  // ignore: unused_field - subscription needed to keep listener alive
  StreamSubscription? _messageSubscription;

  SyncServiceImpl(this._clientEngine) {
    _messageSubscription = _clientEngine.onMessage.listen(_handleMessage);
  }

  void _handleMessage(dynamic data) {
    try {
      final Map<String, dynamic> json = data is String
          ? jsonDecode(data)
          : data;
      final message = MessageModel.fromJson(json);

      if (message.type == MessageType.syncResponse &&
          _pendingSyncCompleter != null) {
        _pendingSyncCompleter!.complete(message.payload);
        _pendingSyncCompleter = null;
      } else if (message.type == MessageType.flash) {
        final triggerTime = message.payload['triggerTime'] as int;
        _flashController.add(triggerTime);
      }
    } catch (e) {
      log('Error parsing message: $e', name: 'SyncServiceImpl');
    }
  }

  @override
  Future<SyncResult> performSync() async {
    final t0 = DateTime.now().millisecondsSinceEpoch;

    // Send SYNC_REQUEST
    _clientEngine.send(
      MessageModel(
        type: MessageType.syncRequest,
        payload: {'t0': t0},
        timestamp: t0,
      ).toJson(),
    );

    // Wait for SYNC_RESPONSE
    _pendingSyncCompleter = Completer<Map<String, dynamic>>();

    try {
      final response = await _pendingSyncCompleter!.future.timeout(
        const Duration(seconds: 2),
        onTimeout: () => throw TimeoutException('Sync timeout'),
      );

      final t3 = DateTime.now().millisecondsSinceEpoch;
      final t1 = response['t1'] as int;
      final t2 = response['t2'] as int;

      // NTP Formula
      final rtt = (t3 - t0) - (t2 - t1);
      final offset = ((t1 - t0) + (t2 - t3)) ~/ 2;

      final result = SyncResult(
        offsetMs: offset,
        rttMs: rtt,
        timestamp: t3,
        isValid: _isValidSample(rtt),
      );

      if (result.isValid) {
        _addSample(result);
      }

      _syncUpdateController.add(result);
      return result;
    } catch (e) {
      log('Sync failed: $e', name: 'SyncServiceImpl');
      return SyncResult(
        offsetMs: currentOffsetMs,
        rttMs: -1,
        timestamp: DateTime.now().millisecondsSinceEpoch,
        isValid: false,
      );
    }
  }

  bool _isValidSample(int rtt) {
    if (_samples.isEmpty) return rtt > 0 && rtt < 1000;

    // Discard if RTT is > 2x the median
    final sortedRtts = _samples.map((s) => s.rttMs).toList()..sort();
    final median = sortedRtts[sortedRtts.length ~/ 2];
    return rtt > 0 && rtt < median * 2;
  }

  void _addSample(SyncResult result) {
    _samples.add(result);
    if (_samples.length > _maxSamples) {
      _samples.removeAt(0);
    }
  }

  @override
  int get currentOffsetMs {
    if (_samples.isEmpty) return 0;
    // Average of valid samples
    final sum = _samples.fold<int>(0, (acc, s) => acc + s.offsetMs);
    return sum ~/ _samples.length;
  }

  @override
  int get currentRttMs {
    if (_samples.isEmpty) return 0;
    final sum = _samples.fold<int>(0, (acc, s) => acc + s.rttMs);
    return sum ~/ _samples.length;
  }

  @override
  int get jitterMs {
    if (_samples.length < 2) return 0;
    final avgRtt = currentRttMs;
    final variance = _samples.fold<int>(
      0,
      (acc, s) => acc + (s.rttMs - avgRtt).abs(),
    );
    return variance ~/ _samples.length;
  }

  @override
  int get correctedTimeMs =>
      DateTime.now().millisecondsSinceEpoch + currentOffsetMs;

  @override
  Stream<SyncResult> get onSyncUpdate => _syncUpdateController.stream;

  @override
  void startPeriodicSync({Duration interval = const Duration(seconds: 5)}) {
    stopPeriodicSync();
    _periodicTimer = Timer.periodic(interval, (_) => performSync());
    // Perform initial sync immediately
    performSync();
  }

  @override
  void stopPeriodicSync() {
    _periodicTimer?.cancel();
    _periodicTimer = null;
  }

  final _flashController = StreamController<int>.broadcast();

  @override
  Stream<int> get onFlashCommand => _flashController.stream;
}
