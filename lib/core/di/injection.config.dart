// GENERATED CODE - DO NOT MODIFY BY HAND

// **************************************************************************
// InjectableConfigGenerator
// **************************************************************************

// ignore_for_file: type=lint
// coverage:ignore-file

// ignore_for_file: no_leading_underscores_for_library_prefixes
import 'package:get_it/get_it.dart' as _i174;
import 'package:injectable/injectable.dart' as _i526;

import '../../application/distributed_metronome_manager.dart' as _i728;
import '../../data/datasources/websocket_client_impl.dart' as _i49;
import '../../data/datasources/websocket_server_impl.dart' as _i262;
import '../../data/network/clock_service.dart' as _i404;
import '../../data/repositories/session_repository_impl.dart' as _i838;
import '../../data/repositories/setlist_repository_impl.dart' as _i966;
import '../../data/repositories/song_repository_impl.dart' as _i512;
import '../../data/services/lrc_parser.dart' as _i955;
import '../../data/services/metronome_runner_impl.dart' as _i1040;
import '../../data/services/soloud_audio_engine.dart' as _i401;
import '../../data/services/sync_service_impl.dart' as _i987;
import '../../domain/repositories/audio_engine.dart' as _i1064;
import '../../domain/repositories/client_engine.dart' as _i349;
import '../../domain/repositories/metronome_runner.dart' as _i254;
import '../../domain/repositories/server_engine.dart' as _i737;
import '../../domain/repositories/session_repository.dart' as _i1;
import '../../domain/repositories/setlist_repository.dart' as _i570;
import '../../domain/repositories/song_repository.dart' as _i715;
import '../../domain/repositories/sync_service.dart' as _i444;
import '../../presentation/bloc/metronome/metronome_bloc.dart' as _i521;

extension GetItInjectableX on _i174.GetIt {
// initializes the registration of main-scope dependencies inside of GetIt
  _i174.GetIt init({
    String? environment,
    _i526.EnvironmentFilter? environmentFilter,
  }) {
    final gh = _i526.GetItHelper(
      this,
      environment,
      environmentFilter,
    );
    gh.factory<_i955.LrcParser>(() => _i955.LrcParser());
    gh.singleton<_i404.ClockService>(() => _i404.ClockService());
    gh.lazySingleton<_i1.SessionRepository>(
        () => _i838.SessionRepositoryImpl());
    gh.singleton<_i1064.AudioEngine>(() => _i401.SoLoudAudioEngine());
    gh.singleton<_i737.ServerEngine>(() => _i262.WebSocketServerImpl());
    gh.singleton<_i254.MetronomeRunner>(
        () => _i1040.MetronomeRunnerImpl(gh<_i1064.AudioEngine>()));
    gh.singleton<_i349.ClientEngine>(() => _i49.WebSocketClientImpl());
    gh.lazySingleton<_i570.SetlistRepository>(
        () => _i966.SetlistRepositoryImpl());
    gh.lazySingleton<_i715.SongRepository>(() => _i512.SongRepositoryImpl());
    gh.singleton<_i444.SyncService>(
        () => _i987.SyncServiceImpl(gh<_i349.ClientEngine>()));
    gh.singleton<_i728.DistributedMetronomeManager>(
        () => _i728.DistributedMetronomeManager(
              gh<_i349.ClientEngine>(),
              gh<_i737.ServerEngine>(),
              gh<_i444.SyncService>(),
            ));
    gh.factory<_i521.MetronomeBloc>(() => _i521.MetronomeBloc(
          gh<_i254.MetronomeRunner>(),
          gh<_i728.DistributedMetronomeManager>(),
        ));
    return this;
  }
}
