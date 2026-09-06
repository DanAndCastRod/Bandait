import 'package:injectable/injectable.dart';
import '../../domain/models/song.dart';
import 'package:uuid/uuid.dart';

@injectable
class LrcParser {
  final Uuid _uuid;

  LrcParser() : _uuid = const Uuid();

  Song parse(String rawContent) {
    final lines = rawContent.split('\n');
    final lyrics = <LyricLine>[];

    // Default metadata
    String title = 'Untitled Song';
    int bpm = 120;
    String signature = '4/4';

    // Regex for [mm:ss.xx] or [mm:ss]
    // Group 1: mm, Group 2: ss, Group 3: xx (optional)
    final timeRegExp = RegExp(r'^\[(\d+):(\d+)(?:\.(\d+))?\](.*)');

    // Regex for Metadata Tags #TAG:Value
    final tagRegExp = RegExp(r'^#([A-Z]+):(.*)');

    // Regex for Standard LRC Tags [ti:Title]
    final standardTagRegExp = RegExp(r'^\[([a-z]+):(.*)\]$');

    for (var line in lines) {
      line = line.trim();
      if (line.isEmpty) continue;

      // 1. Check for Timestamps
      final timeMatch = timeRegExp.firstMatch(line);
      if (timeMatch != null) {
        final minutes = int.parse(timeMatch.group(1)!);
        final seconds = int.parse(timeMatch.group(2)!);
        final hundredthsStr = timeMatch.group(3);
        int millis = (minutes * 60 * 1000) + (seconds * 1000);

        if (hundredthsStr != null) {
          // If 2 digits, it's centiseconds (x10). If 3, milliseconds (x1).
          if (hundredthsStr.length == 2) {
            millis += int.parse(hundredthsStr) * 10;
          } else {
            millis += int.parse(hundredthsStr);
          }
        }

        final text = timeMatch.group(4)?.trim() ?? '';

        // Detect section headers in text, e.g., [Coro] or #Coro
        // For now, treat everything as verse unless it strictly matches a section pattern?
        // Let's just store the text.

        lyrics.add(
          LyricLine(timeMs: millis, text: text, type: _guessType(text)),
        );
        continue;
      }

      // 2. Check for Custom Tags #TAG:Value
      final tagMatch = tagRegExp.firstMatch(line);
      if (tagMatch != null) {
        final key = tagMatch.group(1)!.toUpperCase();
        final value = tagMatch.group(2)!.trim();

        switch (key) {
          case 'TITLE':
            title = value;
            break;
          case 'BPM':
            bpm = int.tryParse(value) ?? 120;
            break;
          case 'SIGNATURE':
            signature = value;
            break;
        }
        continue;
      }

      // 3. Check for Standard Tags [ti:Title]
      final stdTagMatch = standardTagRegExp.firstMatch(line);
      if (stdTagMatch != null) {
        final key = stdTagMatch.group(1)!.toLowerCase();
        final value = stdTagMatch.group(2)!.trim();

        switch (key) {
          case 'ti':
            title = value;
            break;
        }
      }
    }

    // Calculate Duration from last lyric + 5 seconds?
    // Or leave as 0 and calculate dynamically.
    final durationMs = lyrics.isNotEmpty
        ? lyrics.last.timeMs + 5000
        : 180000; // 3 mins default

    return Song(
      id: _uuid.v4(),
      title: title,
      bpm: bpm,
      signature: signature,
      durationMs: durationMs,
      lyrics: lyrics,
    );
  }

  String _guessType(String text) {
    if (text.startsWith('[') && text.endsWith(']')) return 'section_header';
    if (text.isEmpty) return 'spacer';
    return 'verse';
  }
}
