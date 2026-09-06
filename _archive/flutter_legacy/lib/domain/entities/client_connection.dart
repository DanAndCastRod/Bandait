import 'package:equatable/equatable.dart';

class ClientConnection extends Equatable {
  final String id;
  final DateTime connectionTime;
  final DateTime lastPing;

  const ClientConnection({
    required this.id,
    required this.connectionTime,
    required this.lastPing,
  });

  @override
  List<Object> get props => [id, connectionTime, lastPing];

  ClientConnection copyWith({
    String? id,
    DateTime? connectionTime,
    DateTime? lastPing,
  }) {
    return ClientConnection(
      id: id ?? this.id,
      connectionTime: connectionTime ?? this.connectionTime,
      lastPing: lastPing ?? this.lastPing,
    );
  }
}
