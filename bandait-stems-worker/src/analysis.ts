// Music AI result -> Bandait draft (sections with bars, chord charts in ChordPro, BPM, key).
// One implementation for the hub and the leader: both receive the finished draft.
//
// Formats seen on 2026-10-31 with the workflow stems-workflow-releven-bandait:
//   Bpm: number. "Root Key": "E major" / "C# minor".
//   Sections: [{start, end, label}] in seconds, labels Intro/Verse/Chorus/Bridge/Outro; the
//     same label repeats for consecutive phrases (they are merged here).
//   ChordsMap: [{start, end, start_bar, start_beat, end_bar, end_beat, chord_simple_pop, ...}],
//     "N" = no chord. Bars and beats give the bar grid (no separate beats module needed).
//   Lyrics: [{text, language, words: [{word, score}]}] without timestamps: the lines cannot be
//     placed in sections, so they go to lyrics_unplaced. If a later workflow adds word or
//     line timestamps (start/end), they are placed in their section.

export interface MusicAiSection { start: number; end: number; label: string }
export interface MusicAiChord {
  start: number; end: number; start_bar: number; start_beat: number; end_bar?: number; end_beat?: number;
  chord_simple_pop?: string; chord_basic_pop?: string; chord_majmin?: string;
}
export interface MusicAiLyricLine {
  text: string; start?: number; end?: number; words?: { word: string; start?: number; end?: number }[];
}
export interface MusicAiResult {
  Bpm?: number | string; 'Root Key'?: string;
  Sections?: MusicAiSection[]; ChordsMap?: MusicAiChord[]; Lyrics?: MusicAiLyricLine[];
}

export interface DraftSection {
  kind: string; label: string; bars: number; start_bar: number; chordpro: string; cue_text: null;
}
export interface Draft {
  source: 'music.ai';
  bpm: number | null;
  key: string | null;
  beats_per_bar: number;
  sections: DraftSection[];
  lyrics_unplaced: string[];
  notes: string[];
}

const KIND: Record<string, [string, string]> = {
  intro: ['intro', 'Intro'], verse: ['verse', 'Estrofa'], chorus: ['chorus', 'Coro'], 'pre-chorus': ['pre_chorus', 'Pre coro'],
  prechorus: ['pre_chorus', 'Pre coro'], bridge: ['bridge', 'Puente'], outro: ['outro', 'Final'], solo: ['solo', 'Solo'],
  instrumental: ['interlude', 'Interludio'], interlude: ['interlude', 'Interludio'], break: ['break', 'Corte'],
};

function chordName(c: MusicAiChord): string {
  const raw = c.chord_simple_pop ?? c.chord_basic_pop ?? c.chord_majmin ?? 'N';
  return raw === 'N' || !raw ? '' : raw.replace(/:maj$/, '').replace(/:min$/, 'm');
}

/** Root plus major/minor: "C#m7" -> "C#m", "Asus4" -> "A". */
function family(name: string): string {
  const m = /^([A-G][#b]?)(m(?!aj))?/.exec(name);
  return m ? `${m[1]}${m[2] ?? ''}` : name;
}

export function keyName(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = /^([A-G][#b]?)\s*(major|minor|maj|min)?/i.exec(raw.trim());
  if (!m) return null;
  return /^min/i.test(m[2] ?? '') ? `${m[1]}m` : m[1];
}

/** Absolute bar position (in bars, fractional) of a time, interpolated on the chord grid. */
export function barGrid(chords: MusicAiChord[], beatsPerBar = 4): (t: number) => number {
  const pts = chords
    .map((c) => ({ t: c.start, b: c.start_bar + (Math.max(1, c.start_beat) - 1) / beatsPerBar }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.b))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) return () => 0;
  return (t: number) => {
    let i = 1;
    while (i < pts.length - 1 && pts[i].t < t) i++;
    const a = pts[i - 1];
    const b = pts[i];
    const k = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
    return a.b + k * (b.b - a.b);
  };
}

/** Chord chart of [fromBar, toBar): one slot per bar, four bars per line, ChordPro chord-only lines. */
function chart(chords: MusicAiChord[], fromBar: number, toBar: number): string {
  const perBar: string[][] = [];
  for (let bar = fromBar; bar < toBar; bar++) perBar.push([]);
  for (const c of chords) {
    const name = chordName(c);
    if (!name || c.start_bar < fromBar || c.start_bar >= toBar) continue;
    const slot = perBar[c.start_bar - fromBar];
    // C#m / C#m7 / C#m inside one bar is the same harmony read three ways: keep the first.
    if (!slot.some((n) => family(n) === family(name))) slot.push(name);
  }
  // A bar without a new chord keeps the previous one (shown as "%" would confuse singers).
  let last = '';
  for (const c of chords) if (c.start_bar < fromBar && chordName(c)) last = chordName(c);
  const cells = perBar.map((slot) => {
    if (slot.length) last = slot[slot.length - 1];
    return slot.length ? slot.map((n) => `[${n}]`).join(' ') : last ? `[${last}]` : '';
  });
  const lines: string[] = [];
  for (let i = 0; i < cells.length; i += 4) {
    const line = cells.slice(i, i + 4).filter(Boolean).join('    ');
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

export function assemble(result: MusicAiResult, beatsPerBar = 4): Draft {
  const notes: string[] = [];
  const chords = (result.ChordsMap ?? []).filter((c) => Number.isFinite(c.start_bar));
  const rawSections = (result.Sections ?? []).filter((s) => Number.isFinite(s.start) && s.end > s.start);
  const bpmNum = Number(result.Bpm);
  const bpm = Number.isFinite(bpmNum) && bpmNum > 0 ? Math.round(bpmNum * 10) / 10 : null;
  const key = keyName(result['Root Key']);
  const lyrics = (result.Lyrics ?? []).filter((l) => typeof l.text === 'string' && l.text.trim());

  // Merge consecutive phrases with the same label (Music AI splits a chorus in phrases).
  const merged: MusicAiSection[] = [];
  for (const s of rawSections) {
    const prev = merged[merged.length - 1];
    if (prev && prev.label.toLowerCase() === s.label.toLowerCase() && Math.abs(prev.end - s.start) < 0.75) prev.end = s.end;
    else merged.push({ ...s });
  }

  const at = barGrid(chords, beatsPerBar);
  // Song bar 1 = the bar where the first section starts (rounded to the nearest downbeat).
  const firstBar = merged.length ? Math.round(at(merged[0].start)) : 0;
  const counters: Record<string, number> = {};
  const sections: DraftSection[] = [];
  let cursor = firstBar;
  for (let i = 0; i < merged.length; i++) {
    const s = merged[i];
    const endBar = i + 1 < merged.length ? Math.round(at(merged[i + 1].start)) : Math.max(cursor + 1, Math.round(at(s.end)));
    const bars = Math.max(1, endBar - cursor);
    const [kind, base] = KIND[s.label.trim().toLowerCase()] ?? ['custom', s.label.trim() || 'Sección'];
    counters[kind] = (counters[kind] ?? 0) + 1;
    const label = kind === 'verse' ? `${base} ${counters[kind]}` : counters[kind] > 1 && kind !== 'chorus' ? `${base} ${counters[kind]}` : base;
    sections.push({ kind, label, bars, start_bar: cursor - firstBar + 1, chordpro: chart(chords, cursor, cursor + bars), cue_text: null });
    cursor += bars;
  }
  if (!sections.length) notes.push('Music AI no devolvió secciones.');

  // Lyrics with timestamps go to their section; without them they stay unplaced.
  const unplaced: string[] = [];
  for (const line of lyrics) {
    const t = line.start ?? line.words?.find((w) => Number.isFinite(w.start))?.start;
    if (t === undefined || !sections.length) { unplaced.push(line.text.trim()); continue; }
    const bar = Math.floor(at(t)) - firstBar + 1;
    const sec = [...sections].reverse().find((s) => s.start_bar <= bar) ?? sections[0];
    sec.chordpro = sec.chordpro ? `${sec.chordpro}\n${line.text.trim()}` : line.text.trim();
  }
  if (unplaced.length) notes.push('La letra llegó sin tiempos: pégala en cada sección.');
  if (bpm !== null && bpm > 0) notes.push(`Tempo detectado: ${bpm} BPM.`);
  return { source: 'music.ai', bpm, key, beats_per_bar: beatsPerBar, sections, lyrics_unplaced: unplaced, notes };
}
