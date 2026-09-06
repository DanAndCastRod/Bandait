import 'dart:convert';
import 'dart:developer';

import '../domain/enums/message_type.dart';
import '../domain/models/message_model.dart';

/// Callback for when client sends a SYNC_REQUEST and expects a SYNC_RESPONSE.
typedef SyncRequestHandler =
    void Function(String clientId, int t0ClientSent, int t1ServerReceived);

/// Service responsible for parsing and handling incoming messages.
class MessageHandler {
  final SyncRequestHandler? onSyncRequest;

  MessageHandler({this.onSyncRequest});

  /// Parses a raw JSON string into a MessageModel.
  /// Returns null if parsing fails.
  MessageModel? parse(String rawData) {
    try {
      final json = jsonDecode(rawData) as Map<String, dynamic>;
      return MessageModel.fromJson(json);
    } catch (e) {
      log('Failed to parse message: $e', name: 'MessageHandler');
      return null;
    }
  }

  /// Creates a HANDSHAKE response message.
  MessageModel createHandshakeResponse(String clientId) {
    return MessageModel(
      type: MessageType.handshake,
      payload: {
        'clientId': clientId,
        'serverTime': DateTime.now().millisecondsSinceEpoch,
      },
      timestamp: DateTime.now().millisecondsSinceEpoch,
    );
  }

  /// Creates a PONG response to a PING.
  MessageModel createPong(MessageModel pingMessage) {
    return MessageModel(
      type: MessageType.pong,
      payload: {'originalTimestamp': pingMessage.timestamp},
      timestamp: DateTime.now().millisecondsSinceEpoch,
    );
  }

  /// Creates a SYNC_RESPONSE for NTP-like clock synchronization.
  /// t0: Client send time (from request)
  /// t1: Server receive time
  /// t2: Server send time (now)
  MessageModel createSyncResponse({required int t0, required int t1}) {
    final t2 = DateTime.now().millisecondsSinceEpoch;
    return MessageModel(
      type: MessageType.syncResponse,
      payload: {'t0': t0, 't1': t1, 't2': t2},
      timestamp: t2,
    );
  }

  /// Creates a SYNC_REQUEST from the client side.
  MessageModel createSyncRequest() {
    final t0 = DateTime.now().millisecondsSinceEpoch;
    return MessageModel(
      type: MessageType.syncRequest,
      payload: {'t0': t0},
      timestamp: t0,
    );
  }

  /// Creates a PING message.
  MessageModel createPing() {
    return MessageModel(
      type: MessageType.ping,
      payload: {},
      timestamp: DateTime.now().millisecondsSinceEpoch,
    );
  }
}
