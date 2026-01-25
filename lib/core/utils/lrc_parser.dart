import '../../domain/models/song.dart';

class LrcParser {
  static final RegExp _timeTagRegExp = RegExp(r'\[(\d{2}):(\d{2}\.\d{2,3})\]');
  static final RegExp _metaTagRegExp = RegExp(r'\[([a-zA-Z]+):(.*)\]');

  static Song parse(String rawLrc, {String? defaultId}) {
    String title = 'Unknown Title';
    String artist = 'Unknown Artist';
    int bpm = 120;
    List<LyricLine> lyrics = [];

    // ignore: avoid_print
    print(
      'Parsing LRC: ${rawLrc.substring(0, rawLrc.length > 50 ? 50 : rawLrc.length)}...',
    );

    final lines = rawLrc.split('\n');

    for (var line in lines) {
      line = line.trim();
      if (line.isEmpty) continue;

      // Check for Metadata
      final metaMatch = _metaTagRegExp.firstMatch(line);
      if (metaMatch != null) {
        final key = metaMatch.group(1)?.toLowerCase();
        final value = metaMatch.group(2)?.trim() ?? '';

        switch (key) {
          case 'ti':
            title = value;
            break;
          case 'ar':
            artist = value;
            break;
          case 'bpm':
            bpm = int.tryParse(value) ?? 120;
            break;
        }
        continue;
      }

      // Check for Time Tags
      final matches = _timeTagRegExp.allMatches(line);
      if (matches.isNotEmpty) {
        final text = line.substring(matches.last.end).trim();

        for (var match in matches) {
          final minutes = int.parse(match.group(1)!);
          final seconds = double.parse(match.group(2)!);
          final totalMilliseconds = ((minutes * 60 + seconds) * 1000).toInt();

          lyrics.add(
            LyricLine(
              timeMs: totalMilliseconds,
              text: text,
              type: _guessType(text),
            ),
          );
        }
      } else {
        lyrics.add(
          LyricLine(timeMs: 0, text: line.trim(), type: _guessType(line)),
        );
      }
    }

    lyrics.sort((a, b) => a.timeMs.compareTo(b.timeMs));

    // ignore: avoid_print
    print('Parsed ${lyrics.length} lines.');

    return Song(
      id: defaultId ?? DateTime.now().millisecondsSinceEpoch.toString(),
      title: title,
      artist: artist,
      bpm: bpm,
      lyrics: lyrics,
      durationMs: lyrics.isNotEmpty ? lyrics.last.timeMs + 5000 : 0,
    );
  }

  static String _guessType(String text) {
    if (text.startsWith('[') && text.endsWith(']')) return 'section';
    if (text.trim().isEmpty) return 'instrumental';
    return 'verse';
  }
}
