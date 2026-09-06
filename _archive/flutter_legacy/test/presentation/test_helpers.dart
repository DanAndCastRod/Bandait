import 'package:mockito/annotations.dart';
import 'package:bandait/domain/repositories/audio_engine.dart';
import 'package:bandait/domain/repositories/song_repository.dart';
import 'package:bandait/domain/repositories/session_repository.dart';
import 'package:bandait/data/network/clock_service.dart';

@GenerateNiceMocks([
  MockSpec<AudioEngine>(),
  MockSpec<SongRepository>(),
  MockSpec<SessionRepository>(),
  MockSpec<ClockService>(),
])
void main() {}
