// Music AI result -> Bandait draft (sections with bars, chord charts in ChordPro, BPM, key).
// One implementation for the hub and the leader: both receive the finished draft.
//
// Formats seen on 2026-10-31 with the workflow stems-workflow-releven-bandait:
//   Bpm: number. "Root Key": "E major" / "C# minor".
//   Sections: [{start, end, label}] in seconds, labels Intro/Verse/Chorus/Bridge/Outro; the
//     same label repeats for consecutive phrases (they are merged here).
//   ChordsMap: [{start, end, start_bar, start_beat, end_bar, end_beat, chord_simple_pop, ...}],
//     "N" = no chord. Bars and beats give the bar grid (no separate beats module needed).
//   Lyrics: [{text, start, end, language, speaker, words: [{word, start, end, score}]}] since the
//     workflow added alignment (job of 2026-10-31 23:06). Each word is placed in its section and
//     each chord change sits on the word sung when it happens, as Moises shows it:
//     "[A]linea con [E]acorde". Bars without singing stay as chord-only lines. Older results
//     without timestamps leave the lines in lyrics_unplaced.

export interface MusicAiSection { start: number; end: number; label: string }
export interface MusicAiChord {
  start: number; end: number; start_bar: number; start_beat: number; end_bar?: number; end_beat?: number;
  chord_simple_pop?: string; chord_basic_pop?: string; chord_majmin?: string;
}
export interface MusicAiWord { word: string; start?: number; end?: number }
export interface MusicAiLyricLine { text: string; start?: number; end?: number; words?: MusicAiWord[] }

/** Bump when the draft changes shape: the Worker re-assembles cached drafts from the stored result. */
export const ASSEMBLER_VERSION = 2;
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

/** Inverse of barGrid: time (s) of an absolute bar position. */
function timeGrid(chords: MusicAiChord[], beatsPerBar = 4): (bar: number) => number {
  const pts = chords
    .map((c) => ({ t: c.start, b: c.start_bar + (Math.max(1, c.start_beat) - 1) / beatsPerBar }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.b))
    .sort((a, b) => a.b - b.b || a.t - b.t);
  if (pts.length < 2) return () => 0;
  return (bar: number) => {
    let i = 1;
    while (i < pts.length - 1 && pts[i].b < bar) i++;
    const a = pts[i - 1];
    const b = pts[i];
    const k = b.b === a.b ? 0 : (bar - a.b) / (b.b - a.b);
    return a.t + k * (b.t - a.t);
  };
}

interface ChordChange { t: number; bar: number; name: string }

/** Chord changes in time order: no-chord gaps dropped, same harmony re-read (C#m -> C#m7) merged. */
function changes(chords: MusicAiChord[]): ChordChange[] {
  const out: ChordChange[] = [];
  for (const c of [...chords].sort((a, b) => a.start - b.start)) {
    const name = chordName(c);
    if (!name || !Number.isFinite(c.start)) continue;
    const prev = out[out.length - 1];
    if (prev && family(prev.name) === family(name)) continue;
    out.push({ t: c.start, bar: c.start_bar, name });
  }
  return out;
}

interface TimedWord { word: string; start: number; end: number }
interface Phrase { words: TimedWord[]; section: number; fromBar: number; toBar: number }

/** One ChordPro line: each chord before the word sung when it changes; the chord in force opens the line. */
function phraseLine(p: Phrase, own: ChordChange[], all: ChordChange[]): string {
  const slots: string[][] = p.words.map(() => []);
  const trailing: string[] = [];
  const last = p.words[p.words.length - 1];
  for (const c of own) {
    if (c.t > last.end + 0.25) { trailing.push(c.name); continue; }
    let best = 0;
    for (let i = 1; i < p.words.length; i++) {
      if (Math.abs(p.words[i].start - c.t) < Math.abs(p.words[best].start - c.t)) best = i;
    }
    slots[best].push(c.name);
  }
  if (!slots[0].length) {
    const inForce = [...all].reverse().find((c) => c.t <= p.words[0].start + 0.15);
    if (inForce) slots[0].push(inForce.name);
  }
  const text = p.words.map((w, i) => `${slots[i].map((n) => `[${n}]`).join('')}${w.word}`).join(' ');
  return trailing.length ? `${text} ${trailing.map((n) => `[${n}]`).join(' ')}` : text;
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
    // A bar re-reading the held harmony (C#m -> C#m7) shows the held chord.
    if (slot.length === 1 && last && family(slot[0]) === family(last)) slot[0] = last;
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

  const at = barGrid(chords, beatsPerBar);
  // Merge consecutive phrases with the same label (Music AI splits a chorus in phrases), up to
  // 16 bars: past that it is the next pass of the chorus, which the band counts on its own.
  const merged: MusicAiSection[] = [];
  for (const s of rawSections) {
    const prev = merged[merged.length - 1];
    if (prev && prev.label.toLowerCase() === s.label.toLowerCase() && Math.abs(prev.end - s.start) < 0.75
      && (chords.length < 2 || at(s.end) - at(prev.start) <= 16.5)) prev.end = s.end;
    else merged.push({ ...s });
  }

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
    // A verse split in two passes (over 16 bars) keeps its number: "Estrofa 1", "Estrofa 1".
    if (sections[sections.length - 1]?.kind !== kind) counters[kind] = (counters[kind] ?? 0) + 1;
    const label = kind === 'verse' ? `${base} ${counters[kind]}` : counters[kind] > 1 && kind !== 'chorus' ? `${base} ${counters[kind]}` : base;
    sections.push({ kind, label, bars, start_bar: cursor - firstBar + 1, chordpro: chart(chords, cursor, cursor + bars), cue_text: null });
    cursor += bars;
  }
  if (!sections.length) notes.push('Music AI no devolvió secciones.');

  // Lyrics with word timestamps: phrases placed in their section, chords on the words.
  const unplaced: string[] = [];
  const timed: (TimedWord & { line: number })[] = [];
  lyrics.forEach((line, i) => {
    const words = (line.words ?? []).filter((w) => Number.isFinite(w.start) && w.word?.trim());
    if (!words.length || !sections.length) { unplaced.push(line.text.trim()); return; }
    for (const w of words) timed.push({ line: i, word: w.word.trim(), start: w.start!, end: Number.isFinite(w.end) ? w.end! : w.start! });
  });
  if (timed.length) placeLyrics(timed, sections, chords, at, firstBar, beatsPerBar);
  if (unplaced.length) notes.push('La letra llegó sin tiempos: pégala en cada sección.');
  if (bpm !== null && bpm > 0) notes.push(`Tempo detectado: ${bpm} BPM.`);
  return { source: 'music.ai', bpm, key, beats_per_bar: beatsPerBar, sections, lyrics_unplaced: unplaced, notes };
}

function placeLyrics(
  timed: (TimedWord & { line: number })[], sections: DraftSection[], chords: MusicAiChord[],
  at: (t: number) => number, firstBar: number, beatsPerBar: number,
): void {
  const timeAt = timeGrid(chords, beatsPerBar);
  const secStart = sections.map((sec) => sec.start_bar - 1 + firstBar);
  // A pickup sung up to one beat before the downbeat belongs to the section that starts there.
  const sectionOf = (t: number) => {
    const bar = at(t) + 1 / beatsPerBar;
    let i = 0;
    while (i + 1 < secStart.length && secStart[i + 1] <= bar) i++;
    return i;
  };
  const beat = (timeAt(firstBar + 1) - timeAt(firstBar)) / beatsPerBar || 0.5;
  const phrases: Phrase[] = [];
  let cur: Phrase | null = null;
  let curLine = -1;
  for (const w of timed) {
    const section = sectionOf(w.start);
    const prev = cur?.words[cur.words.length - 1];
    // New phrase on a new Music AI line, a new section, a breath of 2+ beats or past 4 bars.
    if (!cur || !prev || w.line !== curLine || section !== cur.section || w.start - prev.end >= 2 * beat
      || at(w.start) - at(cur.words[0].start) >= 4) {
      cur = { words: [], section, fromBar: 0, toBar: 0 };
      phrases.push(cur);
      curLine = w.line;
    }
    cur.words.push({ word: w.word, start: w.start, end: w.end });
  }
  for (const p of phrases) {
    p.fromBar = Math.floor(at(p.words[0].start) + 1 / beatsPerBar);
    p.toBar = Math.max(p.fromBar, Math.floor(at(p.words[p.words.length - 1].end) - 0.05));
  }
  const all = changes(chords);
  // Each chord change goes to the phrase sung over its bar (the latest one already started).
  const owned = new Map<Phrase, ChordChange[]>();
  const free: ChordChange[] = [];
  for (const c of all) {
    const bar = Math.floor(at(c.t) + 0.01);
    const over = phrases.filter((p) => p.fromBar <= bar && bar <= p.toBar);
    const p = [...over].reverse().find((q) => q.words[0].start <= c.t + beat) ?? over[0];
    if (p) owned.set(p, [...(owned.get(p) ?? []), c]);
    else free.push(c);
  }
  sections.forEach((sec, i) => {
    const from = secStart[i];
    const to = from + sec.bars;
    const mine = phrases.filter((p) => p.section === i);
    if (!mine.length) return;
    const items = mine.map((p) => ({ bar: p.fromBar, text: phraseLine(p, owned.get(p) ?? [], all) }));
    // Bars nobody sings: chord-only lines, unless it is a short breath holding the same chord.
    const sung = new Set<number>();
    for (const p of mine) for (let b = p.fromBar; b <= p.toBar; b++) sung.add(b);
    let runStart = -1;
    for (let b = from; b <= to; b++) {
      const open = b < to && !sung.has(b);
      if (open && runStart < 0) runStart = b;
      if (!open && runStart >= 0) {
        if (b - runStart >= 2 || free.some((c) => c.bar >= runStart && c.bar < b)) {
          const text = chart(chords, runStart, b);
          if (text) items.push({ bar: runStart, text });
        }
        runStart = -1;
      }
    }
    sec.chordpro = items.sort((x, y) => x.bar - y.bar).map((x) => x.text).join('\n');
  });
}
