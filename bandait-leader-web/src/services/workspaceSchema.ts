/**
 * Workspace v2 (bandait-protocol/WORKSPACE_V2.md, normativo): migracion v1 -> v2,
 * validacion y calculos por compases.
 *
 * Modulo puro: sin React, sin window ni localStorage. Se prueba con
 * `node scripts/verify-workspace-schema.ts` (parte de `npm run verify:logic`).
 *
 * Reglas que este modulo garantiza:
 * - `migrateWorkspace` es idempotente: aplicada a su propia salida devuelve el MISMO objeto.
 * - Es determinista: dos dispositivos que migran el mismo v1 obtienen exactamente el mismo
 *   v2 (los ids de las canciones creadas se derivan del contenido, no del azar). Asi la
 *   reconciliacion por contenido del motor de sincronizacion los ve "en sincronia" y la
 *   migracion nunca provoca escrituras, ecos ni conflictos.
 * - Nunca cambia un id existente (Song.id, Section.id, PlaylistSong.id ni songId presentes).
 * - Conserva los campos desconocidos en todos los niveles.
 */
import type {
  PlaylistSong,
  SectionKind,
  Song,
  SongSection,
  TransitionMode,
  VoiceConfig,
  VoiceOutput,
  WorkspaceInput,
  WorkspaceStore,
} from '../types/hub.ts'
import { isWorkspaceShape } from '../types/hub.ts'

export const SCHEMA_VERSION = 2

export const BPM_MIN = 40
export const BPM_MAX = 260
export const COUNT_IN_BARS_MAX = 4
export const GAP_SEC_MAX = 30
export const DEFAULT_BPM = 120

/** Fecha fija para canciones creadas por la migracion cuando el setlist no trae una fecha valida. */
export const MIGRATION_EPOCH = '1970-01-01T00:00:00.000Z'

export const SECTION_KINDS: readonly SectionKind[] = [
  'intro',
  'verse',
  'pre_chorus',
  'chorus',
  'bridge',
  'solo',
  'interlude',
  'outro',
  'break',
  'custom',
]

export const TRANSITION_MODES: readonly TransitionMode[] = ['manual_cue', 'auto_count_in', 'gapless']

export const VOICE_OUTPUTS: readonly VoiceOutput[] = ['drummer', 'all_in_ear']

export const VOICE_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'es-CO-SalomeNeural', label: 'Salomé (es-CO, femenina)' },
  { id: 'es-CO-GonzaloNeural', label: 'Gonzalo (es-CO, masculina)' },
]

/** Nombre visible de cada tipo de seccion en el editor. */
export const SECTION_KIND_LABELS: Record<SectionKind, string> = {
  intro: 'Intro',
  verse: 'Estrofa',
  pre_chorus: 'Pre coro',
  chorus: 'Coro',
  bridge: 'Puente',
  solo: 'Solo',
  interlude: 'Interludio',
  outro: 'Final',
  break: 'Corte',
  custom: 'Personalizada',
}

/** Aviso hablado por defecto (WORKSPACE_V2.md, tabla 5.2). `custom` usa el label. */
const DEFAULT_CUE_TEXT: Record<Exclude<SectionKind, 'custom'>, string> = {
  intro: 'Intro',
  verse: 'Estrofa',
  pre_chorus: 'Pre coro',
  chorus: 'Coro',
  bridge: 'Puente',
  solo: 'Solo',
  interlude: 'Interludio',
  outro: 'Final',
  break: 'Corte',
}

export function defaultVoiceConfig(): VoiceConfig {
  return {
    enabled: false,
    provider: 'azure',
    voice: 'es-CO-SalomeNeural',
    rate: '+0%',
    countIn: true,
    sectionCues: true,
    cueLeadBars: 1,
    output: 'drummer',
  }
}

export function defaultCueText(kind: SectionKind, label: string): string {
  return kind === 'custom' ? label : DEFAULT_CUE_TEXT[kind]
}

/** Texto que dira la voz antes de la seccion, o null si no hay aviso. */
export function effectiveCueText(section: Pick<SongSection, 'kind' | 'label' | 'cueText'>): string | null {
  if (section.cueText === null) return null
  if (typeof section.cueText === 'string') return section.cueText
  return defaultCueText(section.kind, section.label)
}

// ---------------------------------------------------------------------------
// Compases y duraciones
// ---------------------------------------------------------------------------

/** Compas de inicio de cada seccion: start_bar = 1 + suma(bars de las anteriores). */
export function sectionStartBars(sections: ReadonlyArray<{ bars: number }>): number[] {
  const starts: number[] = []
  let next = 1
  for (const s of sections) {
    starts.push(next)
    next += safeBars(s.bars)
  }
  return starts
}

export function totalBars(sections: ReadonlyArray<{ bars: number }>): number {
  return sections.reduce((acc, s) => acc + safeBars(s.bars), 0)
}

function safeBars(bars: number): number {
  return Number.isFinite(bars) && bars > 0 ? Math.floor(bars) : 0
}

/** Duracion estimada en segundos: bars * beatsPerBar * 60 / bpm. null si no se puede calcular. */
export function estimateDurationSec(bars: number, beatsPerBar: number, bpm: number): number | null {
  if (!(bars > 0) || !(beatsPerBar > 0) || !(bpm > 0)) return null
  return (bars * beatsPerBar * 60) / bpm
}

/** Duracion por compases de una cancion (con el BPM del show si se indica); null sin secciones. */
export function songDurationSec(song: Pick<Song, 'sections' | 'beatsPerBar' | 'bpm'>, bpmOverride?: number): number | null {
  return estimateDurationSec(totalBars(song.sections), song.beatsPerBar, bpmOverride ?? song.bpm)
}

export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export function clampBpm(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_BPM
  return Math.min(BPM_MAX, Math.max(BPM_MIN, value))
}

export function isValidBpm(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= BPM_MIN && value <= BPM_MAX
}

// ---------------------------------------------------------------------------
// Transiciones (las ejecuta el lider; WORKSPACE_V2.md seccion 4 y CONTRACT_V3 seccion 9)
// ---------------------------------------------------------------------------

export const TRANSITION_EXPLANATIONS: Record<TransitionMode, string> = {
  manual_cue: 'Al terminar la anterior el transporte se detiene; el director pulsa PLAY para entrar.',
  auto_count_in: 'Tras la pausa, arranca solo con los compases de conteo y luego el compás 1.',
  gapless: 'Entra en el compás siguiente al último de la anterior, sin conteo y con su propio BPM.',
}

export const TRANSITION_LABELS: Record<TransitionMode, string> = {
  manual_cue: 'MANUAL CUE',
  auto_count_in: 'AUTO CONTEO',
  gapless: 'GAPLESS / CONTINUO',
}

export interface EntryNotice {
  level: 'warn' | 'info'
  text: string
}

/**
 * Aviso sobre como se entra a un item del setlist. El modo de un item describe como se ENTRA
 * a el; si la cancion anterior no tiene secciones, su final es desconocido y el lider trata la
 * entrada como manual_cue.
 */
export function transitionEntryNotice(
  index: number,
  mode: TransitionMode,
  previousSong: Pick<Song, 'sections'> | null | undefined
): EntryNotice | null {
  if (index === 0) {
    return mode === 'manual_cue' ? null : { level: 'info', text: 'Primer tema: siempre espera PLAY; PLAY dispara su conteo.' }
  }
  if (mode === 'manual_cue') return null
  if (!previousSong || previousSong.sections.length === 0) {
    return {
      level: 'warn',
      text: 'La canción anterior no tiene secciones: su final es desconocido y el líder tratará esta entrada como MANUAL CUE.',
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** Clave de comparacion de title/artist: sin distinguir mayusculas ni espacios extremos. */
export function normalizeMatchText(value: unknown): string {
  return (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)).trim().toLowerCase()
}

export function findSongByTitleArtist<S extends { title?: unknown; artist?: unknown }>(
  songs: readonly S[],
  title: unknown,
  artist: unknown
): S | undefined {
  const t = normalizeMatchText(title)
  const a = normalizeMatchText(artist)
  return songs.find((s) => isPlainObject(s) && normalizeMatchText(s.title) === t && normalizeMatchText(s.artist) === a)
}

/** cyrb128 (dominio publico): hash de 128 bits rapido y sin dependencias. No es criptografico. */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703
  let h2 = 3144134277
  let h3 = 1013904242
  let h4 = 2773480762
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  h1 ^= h2 ^ h3 ^ h4
  h2 ^= h1
  h3 ^= h1
  h4 ^= h1
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0]
}

/**
 * Id con formato UUID v4 (version 4, variante RFC 4122) derivado de `seed`. Solo lo usa la
 * migracion: asi dos dispositivos que migran el mismo v1 generan los mismos ids.
 */
export function deterministicUuid(seed: string): string {
  const hex = cyrb128(seed)
    .map((n) => n.toString(16).padStart(8, '0'))
    .join('')
    .split('')
  hex[12] = '4'
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  const s = hex.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ---------------------------------------------------------------------------
// Migracion v1 -> v2 (WORKSPACE_V2.md seccion 6)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stampFrom(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '' && !Number.isNaN(Date.parse(c))) return c
  }
  return MIGRATION_EPOCH
}

/** Song nueva a partir de un item v1 (paso 2 de la migracion). */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  return value === undefined || value === null ? '' : String(value)
}

function songFromItem(id: string, item: Record<string, unknown>, updatedAt: string): Song {
  const song: Song = {
    id,
    title: textOf(item.title),
    artist: textOf(item.artist),
    bpm: clampBpm(item.bpm),
    beatsPerBar: 4,
    beatUnit: 4,
    key: typeof item.key === 'string' ? item.key : '',
    sections: [],
    updatedAt,
  }
  if (typeof item.camelot === 'string') song.camelot = item.camelot
  if (typeof item.durationSec === 'number' && Number.isFinite(item.durationSec) && item.durationSec >= 0) {
    song.durationSec = item.durationSec
  }
  return song
}

function derivedSongId(bandId: string, item: Record<string, unknown>, used: Set<string>): string {
  const base = `bandait:song:${bandId}:${normalizeMatchText(item.title)}:${normalizeMatchText(item.artist)}`
  for (let n = 0; ; n++) {
    const id = deterministicUuid(n === 0 ? base : `${base}:${n}`)
    if (!used.has(id)) return id
  }
}

/**
 * Migra un workspace v1 (o v2 incompleto) a v2. Idempotente y determinista; corre en cada carga
 * (localStorage, descarga de la nube antes de reconciliar, respaldo restaurado y JSON importado).
 *
 * Por cada banda y cada PlaylistSong sin songId: busca una Song con el mismo title/artist; si no
 * existe la crea (id derivado del contenido); pone songId y completa countInVoice/gapSec.
 * Luego schemaVersion = 2 y voiceMap[bandId] por defecto si falta.
 *
 * Extension conservadora (no contradice la seccion 6): si un songId apunta a una cancion que no
 * existe en NINGUNA banda, se recrea la Song con ESE mismo id desde la copia de respaldo del item,
 * para que el documento nunca tenga referencias rotas.
 *
 * Si `schemaVersion` es mayor que 2 (hub mas nuevo) el documento se devuelve intacto.
 */
export function migrateWorkspace(input: WorkspaceInput): WorkspaceStore {
  const version = input.schemaVersion
  if (typeof version === 'number' && version > SCHEMA_VERSION) {
    return input as unknown as WorkspaceStore
  }

  let changed = version !== SCHEMA_VERSION
  const songsMapIn = isPlainObject(input.songsMap) ? input.songsMap : null
  const voiceMapIn = isPlainObject(input.voiceMap) ? input.voiceMap : null
  if (!songsMapIn || !voiceMapIn) changed = true
  const songsMap: Record<string, unknown> = { ...(songsMapIn ?? {}) }
  const voiceMap: Record<string, unknown> = { ...(voiceMapIn ?? {}) }
  const playlistsMap: Record<string, unknown> = { ...(input.playlistsMap as Record<string, unknown>) }
  let playlistsChanged = false

  // Todos los ids de canciones del documento: un id derivado nunca debe chocar con uno existente.
  const usedIds = new Set<string>()
  for (const list of Object.values(songsMap)) {
    if (!Array.isArray(list)) continue
    for (const s of list) if (isPlainObject(s) && typeof s.id === 'string') usedIds.add(s.id)
  }

  const bandIds: string[] = []
  for (const b of input.bands) if (!bandIds.includes(b.id)) bandIds.push(b.id)
  for (const k of Object.keys(playlistsMap)) if (!bandIds.includes(k)) bandIds.push(k)

  for (const bandId of bandIds) {
    const rawSongs = songsMap[bandId]
    let songs: unknown[] = Array.isArray(rawSongs) ? rawSongs : []
    let songsChanged = !Array.isArray(rawSongs)
    // Solo canciones con id utilizable: emparejar con una corrupta romperia la idempotencia.
    const songsList = () =>
      songs.filter((s): s is Record<string, unknown> => isPlainObject(s) && typeof s.id === 'string' && s.id !== '')

    const rawPlaylists = playlistsMap[bandId]
    if (Array.isArray(rawPlaylists)) {
      let listChanged = false
      const nextPlaylists = rawPlaylists.map((pl: unknown) => {
        if (!isPlainObject(pl) || !Array.isArray(pl.songs)) return pl
        const stamp = stampFrom(pl.updatedAt, pl.createdAt)
        let itemsChanged = false
        const items = pl.songs.map((item: unknown) => {
          if (!isPlainObject(item)) return item
          let next: Record<string, unknown> = item
          const sid = item.songId
          if (typeof sid !== 'string' || sid.trim() === '') {
            let match = findSongByTitleArtist(songsList(), item.title, item.artist)
            if (!match) {
              const id = derivedSongId(bandId, item, usedIds)
              const created = songFromItem(id, item, stamp)
              songs = [...songs, created]
              songsChanged = true
              usedIds.add(id)
              match = created as unknown as Record<string, unknown>
            }
            next = { ...next, songId: match.id }
          } else if (!usedIds.has(sid)) {
            songs = [...songs, songFromItem(sid, item, stamp)]
            songsChanged = true
            usedIds.add(sid)
          }
          if (typeof next.countInVoice !== 'boolean') next = { ...next, countInVoice: true }
          if (typeof next.gapSec !== 'number' || !Number.isFinite(next.gapSec)) next = { ...next, gapSec: 0 }
          if (next !== item) itemsChanged = true
          return next
        })
        if (!itemsChanged) return pl
        listChanged = true
        return { ...pl, songs: items }
      })
      if (listChanged) {
        playlistsMap[bandId] = nextPlaylists
        playlistsChanged = true
      }
    }

    if (songsChanged) {
      songsMap[bandId] = songs
      changed = true
    }
  }

  for (const band of input.bands) {
    if (!isPlainObject(voiceMap[band.id])) {
      voiceMap[band.id] = defaultVoiceConfig()
      changed = true
    }
  }
  if (playlistsChanged) changed = true
  if (!changed) return input as unknown as WorkspaceStore

  return {
    ...input,
    schemaVersion: SCHEMA_VERSION,
    playlistsMap: (playlistsChanged ? playlistsMap : input.playlistsMap) as WorkspaceStore['playlistsMap'],
    songsMap: songsMap as WorkspaceStore['songsMap'],
    voiceMap: voiceMap as WorkspaceStore['voiceMap'],
  }
}

/**
 * Punto de entrada unico para cualquier JSON de workspace que llega a la app (localStorage,
 * fila de la nube, respaldo, archivo importado): quita `_sync` (metadato del motor, lo agrega
 * el adaptador al escribir), valida la forma minima y migra. null si no es un workspace.
 */
export function loadWorkspaceDocument(raw: unknown): WorkspaceStore | null {
  if (!isPlainObject(raw)) return null
  let candidate: Record<string, unknown> = raw
  if ('_sync' in raw) {
    candidate = { ...raw }
    delete candidate._sync
  }
  return isWorkspaceShape(candidate) ? migrateWorkspace(candidate) : null
}

export type ImportResult = { ok: true; workspace: WorkspaceStore; warnings: string[] } | { ok: false; error: string }

/**
 * JSON importado por el usuario: acepta el documento v1/v2 tal cual o la exportacion del Hub
 * (que lo trae en `workspace`). Migra y valida; rechaza si quedan errores.
 */
export function parseImportedWorkspace(parsed: unknown): ImportResult {
  const candidate = isPlainObject(parsed) && isPlainObject(parsed.workspace) ? parsed.workspace : parsed
  const ws = loadWorkspaceDocument(candidate)
  if (!ws) {
    if (isPlainObject(parsed) && 'agrupacion' in parsed) {
      return {
        ok: false,
        error: 'Es una exportación antigua: solo trae la banda activa, no el workspace completo. Exporta de nuevo desde un Hub actualizado.',
      }
    }
    return { ok: false, error: 'El archivo no contiene un workspace de Bandait válido.' }
  }
  const result = validateWorkspace(ws)
  if (!result.ok) {
    const more = result.errors.length > 3 ? ` (y ${result.errors.length - 3} más)` : ''
    return { ok: false, error: `El workspace tiene errores: ${result.errors.slice(0, 3).join(' ')}${more}` }
  }
  return { ok: true, workspace: ws, warnings: result.warnings }
}

// ---------------------------------------------------------------------------
// Validacion v2
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const RATE_RE = /^\+(?:[0-9]|[1-4][0-9]|50)%$/

export function validateSection(section: unknown, path: string, errors: string[], warnings: string[]): void {
  if (!isPlainObject(section)) {
    errors.push(`${path}: no es un objeto.`)
    return
  }
  if (typeof section.id !== 'string' || section.id.trim() === '') errors.push(`${path}.id: falta o está vacío.`)
  if (!SECTION_KINDS.includes(section.kind as SectionKind)) errors.push(`${path}.kind: valor inválido ${JSON.stringify(section.kind)}.`)
  if (typeof section.label !== 'string') errors.push(`${path}.label: debe ser texto.`)
  if (!isInt(section.bars) || section.bars < 1) errors.push(`${path}.bars: debe ser un entero >= 1 (es ${JSON.stringify(section.bars)}).`)
  if (typeof section.chordpro !== 'string') errors.push(`${path}.chordpro: debe ser texto (puede ser "").`)
  else if (/\{\s*(start_of_|end_of_|so[cvbtg]\s*[:}]|eo[cvbtg]\s*})/i.test(section.chordpro)) {
    warnings.push(`${path}.chordpro: contiene directivas {start_of_*}/{end_of_*}; la sección ya delimita el bloque.`)
  }
  if (section.cueText !== undefined && section.cueText !== null && typeof section.cueText !== 'string') {
    errors.push(`${path}.cueText: debe ser texto, null o ausente.`)
  }
}

export function validateSong(song: unknown, path: string, errors: string[], warnings: string[]): void {
  if (!isPlainObject(song)) {
    errors.push(`${path}: no es un objeto.`)
    return
  }
  if (typeof song.id !== 'string' || song.id.trim() === '') errors.push(`${path}.id: falta o está vacío.`)
  else if (!UUID_RE.test(song.id)) warnings.push(`${path}.id: "${song.id}" no tiene formato UUID.`)
  if (typeof song.title !== 'string') errors.push(`${path}.title: debe ser texto.`)
  if (typeof song.artist !== 'string') errors.push(`${path}.artist: debe ser texto.`)
  if (!isValidBpm(song.bpm)) errors.push(`${path}.bpm: debe estar entre ${BPM_MIN} y ${BPM_MAX} (es ${JSON.stringify(song.bpm)}).`)
  if (!isInt(song.beatsPerBar) || song.beatsPerBar < 1) errors.push(`${path}.beatsPerBar: debe ser un entero >= 1.`)
  if (!isInt(song.beatUnit) || song.beatUnit < 1) errors.push(`${path}.beatUnit: debe ser un entero >= 1.`)
  if (typeof song.key !== 'string') errors.push(`${path}.key: debe ser texto.`)
  if (song.camelot !== undefined && typeof song.camelot !== 'string') errors.push(`${path}.camelot: debe ser texto.`)
  if (song.durationSec !== undefined && (!isNum(song.durationSec) || song.durationSec < 0)) {
    errors.push(`${path}.durationSec: debe ser un número >= 0.`)
  }
  if (song.notes !== undefined && typeof song.notes !== 'string') errors.push(`${path}.notes: debe ser texto.`)
  if (typeof song.updatedAt !== 'string' || Number.isNaN(Date.parse(song.updatedAt))) {
    errors.push(`${path}.updatedAt: debe ser una fecha ISO 8601.`)
  }
  if (!Array.isArray(song.sections)) {
    errors.push(`${path}.sections: debe ser una lista (puede estar vacía).`)
    return
  }
  const ids = new Set<string>()
  song.sections.forEach((section: unknown, i: number) => {
    const p = `${path}.sections[${i}]`
    validateSection(section, p, errors, warnings)
    if (isPlainObject(section) && typeof section.id === 'string') {
      if (ids.has(section.id)) errors.push(`${p}.id: "${section.id}" repetido dentro de la canción.`)
      ids.add(section.id)
    }
  })
}

export function validateVoiceConfig(voice: unknown, path: string, errors: string[], warnings: string[]): void {
  if (!isPlainObject(voice)) {
    errors.push(`${path}: falta o no es un objeto.`)
    return
  }
  if (typeof voice.enabled !== 'boolean') errors.push(`${path}.enabled: debe ser booleano.`)
  if (voice.provider !== 'azure') errors.push(`${path}.provider: debe ser "azure".`)
  if (typeof voice.voice !== 'string' || voice.voice === '') errors.push(`${path}.voice: falta.`)
  else if (!voice.voice.startsWith('es-')) warnings.push(`${path}.voice: "${voice.voice}" no es una voz es-*.`)
  if (typeof voice.rate !== 'string' || !RATE_RE.test(voice.rate)) errors.push(`${path}.rate: debe ir de "+0%" a "+50%".`)
  if (typeof voice.countIn !== 'boolean') errors.push(`${path}.countIn: debe ser booleano.`)
  if (typeof voice.sectionCues !== 'boolean') errors.push(`${path}.sectionCues: debe ser booleano.`)
  if (voice.cueLeadBars !== 1 && voice.cueLeadBars !== 2) errors.push(`${path}.cueLeadBars: debe ser 1 o 2.`)
  if (!VOICE_OUTPUTS.includes(voice.output as VoiceOutput)) errors.push(`${path}.output: debe ser "drummer" o "all_in_ear".`)
}

export function validatePlaylistItem(
  item: unknown,
  path: string,
  bandSongIds: ReadonlySet<string>,
  errors: string[],
  warnings: string[]
): void {
  if (!isPlainObject(item)) {
    errors.push(`${path}: no es un objeto.`)
    return
  }
  if (typeof item.id !== 'string' || item.id === '') errors.push(`${path}.id: falta.`)
  if (typeof item.songId !== 'string' || item.songId === '') errors.push(`${path}.songId: falta (obligatorio en v2).`)
  else if (!bandSongIds.has(item.songId)) errors.push(`${path}.songId: "${item.songId}" no existe en la librería de la banda.`)
  if (!TRANSITION_MODES.includes(item.transitionMode as TransitionMode)) {
    errors.push(`${path}.transitionMode: valor inválido ${JSON.stringify(item.transitionMode)}.`)
  }
  if (!isInt(item.countInBars) || item.countInBars < 0 || item.countInBars > COUNT_IN_BARS_MAX) {
    errors.push(`${path}.countInBars: debe ser un entero de 0 a ${COUNT_IN_BARS_MAX}.`)
  }
  if (typeof item.countInVoice !== 'boolean') errors.push(`${path}.countInVoice: debe ser booleano.`)
  if (!isNum(item.gapSec) || item.gapSec < 0 || item.gapSec > GAP_SEC_MAX) errors.push(`${path}.gapSec: debe estar entre 0 y ${GAP_SEC_MAX}.`)
  if (!isNum(item.bpm)) errors.push(`${path}.bpm: debe ser un número.`)
  else if (!isValidBpm(item.bpm)) warnings.push(`${path}.bpm: ${item.bpm} fuera de ${BPM_MIN}..${BPM_MAX}.`)
  if (!isNum(item.orderIndex)) warnings.push(`${path}.orderIndex: debe ser un número.`)
  for (const f of ['title', 'artist', 'key', 'showKey', 'camelot'] as const) {
    if (typeof item[f] !== 'string') warnings.push(`${path}.${f}: debe ser texto.`)
  }
  if (!isNum(item.durationSec)) warnings.push(`${path}.durationSec: debe ser un número.`)
}

/** Valida un workspace v2 completo contra WORKSPACE_V2.md. No modifica nada. */
export function validateWorkspace(value: unknown): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  if (!isWorkspaceShape(value)) {
    return { ok: false, errors: ['La raíz no tiene la forma de un workspace (bands, activeBandId y mapas).'], warnings }
  }
  const ws = value as WorkspaceInput
  if (ws.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion: debe ser ${SCHEMA_VERSION} (es ${JSON.stringify(ws.schemaVersion)}).`)
  if (!ws.bands.some((b) => b.id === ws.activeBandId)) warnings.push('activeBandId: no corresponde a ninguna banda.')
  const songsMap = isPlainObject(ws.songsMap) ? ws.songsMap : null
  const voiceMap = isPlainObject(ws.voiceMap) ? ws.voiceMap : null
  if (!songsMap) errors.push('songsMap: falta o no es un objeto.')
  if (!voiceMap) errors.push('voiceMap: falta o no es un objeto.')

  const songIdsByBand = new Map<string, Set<string>>()
  const seenAcrossBands = new Map<string, string>()
  for (const band of ws.bands) {
    const ids = new Set<string>()
    songIdsByBand.set(band.id, ids)
    if (songsMap) {
      const list = songsMap[band.id]
      if (!Array.isArray(list)) {
        errors.push(`songsMap.${band.id}: falta o no es una lista.`)
      } else {
        list.forEach((song: unknown, i: number) => {
          const p = `songsMap.${band.id}[${i}]`
          validateSong(song, p, errors, warnings)
          if (isPlainObject(song) && typeof song.id === 'string') {
            if (ids.has(song.id)) errors.push(`${p}.id: "${song.id}" repetido en la librería de la banda.`)
            const other = seenAcrossBands.get(song.id)
            if (other && other !== band.id) warnings.push(`${p}.id: "${song.id}" también existe en la banda ${other}.`)
            ids.add(song.id)
            seenAcrossBands.set(song.id, band.id)
          }
        })
      }
    }
    if (voiceMap) validateVoiceConfig(voiceMap[band.id], `voiceMap.${band.id}`, errors, warnings)
  }

  for (const [bandId, playlists] of Object.entries(ws.playlistsMap as Record<string, unknown>)) {
    if (!Array.isArray(playlists)) {
      errors.push(`playlistsMap.${bandId}: no es una lista.`)
      continue
    }
    const bandSongIds = songIdsByBand.get(bandId) ?? new Set<string>()
    playlists.forEach((pl: unknown, i: number) => {
      const p = `playlistsMap.${bandId}[${i}]`
      if (!isPlainObject(pl) || !Array.isArray(pl.songs)) {
        errors.push(`${p}: no es un setlist válido (falta songs).`)
        return
      }
      pl.songs.forEach((item: unknown, j: number) => validatePlaylistItem(item, `${p}.songs[${j}]`, bandSongIds, errors, warnings))
    })
  }

  return { ok: errors.length === 0, errors, warnings }
}

/** Item nuevo de setlist que referencia una Song de la libreria. */
export function playlistItemFromSong(song: Song, overrides: Partial<PlaylistSong> = {}): Omit<PlaylistSong, 'id' | 'orderIndex'> {
  const byBars = songDurationSec(song)
  return {
    songId: song.id,
    title: song.title,
    artist: song.artist,
    bpm: song.bpm,
    key: song.key,
    showKey: song.key,
    camelot: song.camelot ?? '',
    durationSec: Math.round(byBars ?? song.durationSec ?? 0),
    transitionMode: 'manual_cue',
    countInBars: 1,
    countInVoice: true,
    gapSec: 0,
    notes: '',
    ...overrides,
  }
}
