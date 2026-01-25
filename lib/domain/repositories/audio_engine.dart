abstract class AudioEngine {
  /// Initializes the audio engine.
  Future<void> initialize();

  /// Plays the strong 'Tick' sound (e.g. first beat).
  void playTick();

  /// Plays the weak 'Tock' sound (e.g. other beats).
  void playTock();

  /// Disposes the audio engine and releases resources.
  Future<void> dispose();

  // Settings
  Future<void> setGlobalOffset(int ms);
  Future<void> setBufferLength(int samples);
  Future<int> getGlobalOffset();
  Future<int> getBufferLength();
  Future<double> measureLatency();
}
