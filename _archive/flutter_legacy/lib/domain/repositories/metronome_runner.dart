abstract class MetronomeRunner {
  Stream<int> get onTick; // Emits current beat number (1, 2, 3...)
  bool get isPlaying;
  int get bpm;

  Future<void> start();
  Future<void> startAt(int targetTimestamp);
  void stop();
  void setBpm(int bpm);
}
