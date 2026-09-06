import 'package:freezed_annotation/freezed_annotation.dart';

part 'metronome_event.freezed.dart';

@freezed
class MetronomeEvent with _$MetronomeEvent {
  const factory MetronomeEvent.started({int? startAt}) = Started;
  const factory MetronomeEvent.stopped() = Stopped;
  const factory MetronomeEvent.bpmChanged(int newBpm) = BpmChanged;
  const factory MetronomeEvent.ticked(int beat) = Ticked;
}
