import { describe, it, expect } from 'vitest'
import fixtures from '../../../../bandait-protocol/fixtures/v3_messages.json'
import { decodeSessionState, decodeSongContent } from '../../protocol/wire'
import { chordChunks, lyricLines, parsePrompterLines, wrapChunks } from '../chordpro'
import { SONG_MAX_ATTEMPTS, SongContentStore, SongFetch, SongTimers, sectionIndexAt, songContentUrl } from '../songContent'
import { SetlistEntry, SongSection } from '../../types/protocol'

const SONG = fixtures.song_content

function entry(songId: string, contentEtag: string | null, orderIndex = 0): SetlistEntry {
  return { songId, title: songId, bpm: 120, orderIndex, transitionMode: 'manual_cue', contentEtag }
}

function section(id: string, startBar: number, bars: number): SongSection {
  return { id, kind: 'verse', label: id, bars, startBar, chordpro: '', cueText: null }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

class FakeTimers implements SongTimers {
  pending: Array<() => void> = []
  setTimeout(fn: () => void, ms: number) {
    if (ms < 4000) this.pending.push(fn) // retries; fetch timeouts are not run
    return this.pending.length
  }
  clearTimeout() {}
  runRetries() {
    const fns = this.pending
    this.pending = []
    fns.forEach((fn) => fn())
  }
}

function fakeFetch(responses: Record<string, unknown>, calls: string[], failFirst = 0): SongFetch {
  let failures = failFirst
  return async (url) => {
    calls.push(url)
    if (failures > 0) {
      failures -= 1
      throw new Error('red caida')
    }
    const id = decodeURIComponent(url.replace(/^.*\/songs\//, '').replace(/\.json$/, ''))
    const body = responses[id]
    return body === undefined
      ? { ok: false, status: 404, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => body }
  }
}

describe('wire: song content (CONTRACT_V3 9.1)', () => {
  it('decodes the song_content fixture', () => {
    const res = decodeSongContent(SONG)
    if (!res.ok) throw new Error(res.error)
    expect(res.value.songId).toBe('song_01')
    expect(res.value.showKey).toBe('Am')
    expect(res.value.sections.map((s) => [s.id, s.startBar, s.bars])).toEqual([
      ['s-01', 1, 4],
      ['s-02', 5, 8],
      ['s-04', 13, 4],
    ])
    expect(res.value.sections[2].cueText).toBeNull()
  })

  it('rejects a section without bars', () => {
    const bad = JSON.parse(JSON.stringify(SONG))
    bad.sections[0].bars = 0
    expect(decodeSongContent(bad).ok).toBe(false)
  })

  it('content_etag is optional in the setlist (leaders before v3.2)', () => {
    const state = JSON.parse(JSON.stringify(fixtures.state_idle))
    state.setlist = [{ song_id: 'a', title: 'A', bpm: 100, order_index: 0, transition_mode: 'manual_cue' }]
    const res = decodeSessionState(state)
    if (!res.ok) throw new Error(res.error)
    expect(res.value.setlist[0].contentEtag).toBeNull()
  })
})

describe('chordpro', () => {
  it('splits a line into chord chunks', () => {
    expect(chordChunks('[Am]Hoy vuelvo a [F]casa')).toEqual([
      { chord: 'Am', text: 'Hoy vuelvo a ' },
      { chord: 'F', text: 'casa' },
    ])
    expect(chordChunks('Sin acordes')).toEqual([{ chord: '', text: 'Sin acordes' }])
    expect(chordChunks('[Am]  [F]')).toEqual([
      { chord: 'Am', text: '  ' },
      { chord: 'F', text: '' },
    ])
  })

  it('wraps between words, keeping the chord on the first word', () => {
    expect(wrapChunks(chordChunks('[F]casa con la'))).toEqual([
      { chord: 'F', text: 'casa ' },
      { chord: '', text: 'con ' },
      { chord: '', text: 'la' },
    ])
    expect(wrapChunks(chordChunks('[G]  hola'))).toEqual([
      { chord: 'G', text: '  ' },
      { chord: '', text: 'hola' },
    ])
  })

  it('keeps comments, drops other directives and blank lines; singer view drops chord-only lines', () => {
    const lines = parsePrompterLines('{c: Todos}\n[Am]  [F]\n\n{textfont: x}\n[C]con la noche en [G]calma')
    expect(lines.map((l) => l.type)).toEqual(['comment', 'chords', 'chords'])
    expect(lyricLines(lines)).toEqual(['con la noche en calma'])
  })
})

describe('sectionIndexAt', () => {
  const sections = [section('a', 1, 4), section('b', 5, 8), section('c', 13, 4)]
  it('follows the bar', () => {
    expect(sectionIndexAt(sections, null)).toBe(0)
    expect(sectionIndexAt(sections, -1)).toBe(0) // count-in
    expect(sectionIndexAt(sections, 4)).toBe(0)
    expect(sectionIndexAt(sections, 5)).toBe(1)
    expect(sectionIndexAt(sections, 13)).toBe(2)
    expect(sectionIndexAt(sections, 99)).toBe(2)
    expect(sectionIndexAt([], 3)).toBe(-1)
  })
})

describe('SongContentStore', () => {
  const base = 'http://192.168.1.4:4040'

  it('builds the song url', () => {
    expect(songContentUrl(`${base}/`, 'a b')).toBe(`${base}/songs/a%20b.json`)
  })

  it('fetches the current song first, only when content_etag changes', async () => {
    const calls: string[] = []
    const store = new SongContentStore(fakeFetch({ song_01: SONG, song_02: { ...SONG, song_id: 'song_02', content_etag: 'e2' } }, calls), new FakeTimers())
    let notified = 0
    store.subscribe(() => notified++)
    const setlist = [entry('song_02', 'e2', 0), entry('song_01', SONG.content_etag, 1), entry('song_09', null, 2)]
    store.sync(base, setlist, 'song_01')
    await flush()
    await flush()
    expect(calls[0]).toBe(`${base}/songs/song_01.json`)
    expect(calls).toHaveLength(2) // song_09 has no etag: older leader, never asked
    expect(store.get('song_01')?.sections).toHaveLength(3)
    expect(notified).toBe(2)

    store.sync(base, setlist, 'song_01')
    await flush()
    expect(calls).toHaveLength(2) // same etag: nothing new
  })

  it('keeps the content when the network drops (Flywheel)', async () => {
    const calls: string[] = []
    const store = new SongContentStore(fakeFetch({ song_01: SONG }, calls), new FakeTimers())
    store.sync(base, [entry('song_01', SONG.content_etag)], 'song_01')
    await flush()
    await flush()
    store.sync(null, [entry('song_01', 'otro')], 'song_01')
    expect(store.get('song_01')?.contentEtag).toBe(SONG.content_etag)
  })

  it('retries after a network error, and gives up after a few attempts', async () => {
    const calls: string[] = []
    const timers = new FakeTimers()
    const store = new SongContentStore(fakeFetch({ song_01: SONG }, calls, 1), timers)
    store.sync(base, [entry('song_01', SONG.content_etag)], 'song_01')
    await flush()
    expect(store.get('song_01')).toBeNull()
    timers.runRetries()
    await flush()
    await flush()
    expect(store.get('song_01')).not.toBeNull()

    const calls2: string[] = []
    const store2 = new SongContentStore(fakeFetch({}, calls2, 99), timers)
    store2.sync(base, [entry('song_01', 'x')], 'song_01')
    for (let i = 0; i < SONG_MAX_ATTEMPTS + 2; i++) {
      await flush()
      timers.runRetries()
    }
    await flush()
    expect(calls2).toHaveLength(SONG_MAX_ATTEMPTS)
    expect(store2.hasFailed('song_01')).toBe(true)
    store2.sync(base, [entry('song_01', 'y')], 'song_01') // new etag: tries again
    expect(store2.hasFailed('song_01')).toBe(false)
  })

  it('does not insist on a 404 (song left the leader setlist)', async () => {
    const calls: string[] = []
    const timers = new FakeTimers()
    const store = new SongContentStore(fakeFetch({}, calls), timers)
    store.sync(base, [entry('song_05', 'x')], 'song_05')
    await flush()
    timers.runRetries()
    await flush()
    expect(calls).toHaveLength(1)
    expect(store.hasFailed('song_05')).toBe(true)
  })
})
