import 'package:freezed_annotation/freezed_annotation.dart';

part 'metronome_state.freezed.dart';

@freezed
class MetronomeState with _$MetronomeState {
  const factory MetronomeState({
    @Default(false) bool isPlaying,
    @Default(120) int bpm,
    @Default(1) int currentBeat,
  }) = _MetronomeState;
}
