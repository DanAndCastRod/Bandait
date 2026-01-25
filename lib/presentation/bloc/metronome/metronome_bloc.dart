import 'dart:async';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:injectable/injectable.dart';
import '../../../domain/repositories/metronome_runner.dart';
import '../../../application/distributed_metronome_manager.dart';
import 'metronome_event.dart';
import 'metronome_state.dart';

@injectable
class MetronomeBloc extends Bloc<MetronomeEvent, MetronomeState> {
  final MetronomeRunner _runner;
  final DistributedMetronomeManager _manager;
  StreamSubscription<int>? _tickSubscription;
  StreamSubscription? _remoteStartSub;
  StreamSubscription? _remoteStopSub;

  MetronomeBloc(this._runner, this._manager) : super(const MetronomeState()) {
    on<Started>(_onStarted);
    on<Stopped>(_onStopped);
    on<BpmChanged>(_onBpmChanged);
    on<Ticked>(_onTicked);

    _remoteStartSub = _manager.onRemoteStart.listen((targetTime) {
      add(MetronomeEvent.started(startAt: targetTime));
    });

    _remoteStopSub = _manager.onRemoteStop.listen((_) {
      add(const MetronomeEvent.stopped());
    });

    _manager.onRemoteBpmChange.listen((bpm) {
      add(MetronomeEvent.bpmChanged(bpm));
    });
  }

  void _onStarted(Started event, Emitter<MetronomeState> emit) async {
    _runner.setBpm(state.bpm);
    if (event.startAt != null) {
      await _runner.startAt(event.startAt!);
    } else {
      await _runner.start();
    }
    emit(state.copyWith(isPlaying: true));

    _tickSubscription?.cancel();
    _tickSubscription = _runner.onTick.listen((beat) {
      add(MetronomeEvent.ticked(beat));
    });
  }

  void _onStopped(Stopped event, Emitter<MetronomeState> emit) {
    _runner.stop();
    _tickSubscription?.cancel();
    emit(state.copyWith(isPlaying: false, currentBeat: 1));
  }

  void _onBpmChanged(BpmChanged event, Emitter<MetronomeState> emit) {
    _runner.setBpm(event.newBpm);
    emit(state.copyWith(bpm: event.newBpm));
  }

  void _onTicked(Ticked event, Emitter<MetronomeState> emit) {
    emit(state.copyWith(currentBeat: event.beat));
  }

  @override
  Future<void> close() {
    _tickSubscription?.cancel();
    _remoteStartSub?.cancel();
    _remoteStopSub?.cancel();
    _runner.stop();
    return super.close();
  }
}
