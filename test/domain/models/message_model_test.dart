import 'package:test/test.dart';
import 'package:bandait/domain/models/message_model.dart';

void main() {
  group('MessageModel', () {
    test('fromJson creates correct instance for HANDSHAKE', () {
      final json = {
        'type': 'HANDSHAKE',
        'payload': {'deviceId': 'device-123'},
        'timestamp': 1625247890000,
      };

      final message = MessageModel.fromJson(json);

      expect(message.type, MessageType.handshake);
      expect(message.payload, {'deviceId': 'device-123'});
      expect(message.timestamp, 1625247890000);
      expect(message.id, isNull);
    });

    test('toJson returns correct map for PING', () {
      final message = MessageModel(
        type: MessageType.ping,
        timestamp: 1625247890001,
      );

      final json = message.toJson();

      expect(json['type'], 'PING');
      expect(json['timestamp'], 1625247890001);
      expect(json.containsKey('payload'), isFalse);
      expect(json.containsKey('id'), isFalse);
    });

    test('Round trip serialization for ACK', () {
      final original = MessageModel(
        type: MessageType.ack,
        id: 'msg-abc',
        timestamp: 1625247890002,
        payload: {'status': 'ok'},
      );

      final json = original.toJson();
      final decoded = MessageModel.fromJson(json);

      expect(decoded, original);
    });

    test('fromJson throws FormatException for unknown type', () {
      final json = {
        'type': 'UNKNOWN_TYPE',
        'timestamp': 1625247890000,
      };

      expect(() => MessageModel.fromJson(json), throwsFormatException);
    });

    test('Case insensitivity for type parsing', () {
      final json = {
        'type': 'pong',
        'timestamp': 1625247890000,
      };

      final message = MessageModel.fromJson(json);
      expect(message.type, MessageType.pong);
    });
  });
}
