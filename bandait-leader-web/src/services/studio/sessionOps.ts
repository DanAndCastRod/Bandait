/**
 * Operaciones de edicion del Estudio Bandait: (sesion, argumentos) => sesion NUEVA.
 *
 * Reglas (types.ts, seccion sessionOps):
 *   - Nunca mutan la entrada. Copian solo lo que cambia: las pistas y clips intactos conservan
 *     su referencia, para que React y el motor comparen por identidad.
 *   - Si la operacion no cambia nada devuelven la MISMA referencia de sesion.
 *   - Un id inexistente o un resultado que violaria el contrato lanza StudioSessionError. Los
 *     valores numericos fuera de rango se acotan al limite; un numero no finito (NaN) lanza.
 *   - No tocan `updatedAt` (lo pone studioStore al guardar). Los ids nuevos llegan por parametro.
 *
 * Decisiones de borde que el contrato no fija:
 *   - splitClip en el borde del clip (o tan cerca que una mitad quedaria con menos de 10 ms) no
 *     hace nada y devuelve la misma sesion: pulsar S con el cabezal en el borde no es un error.
 *   - Al recortar, si los fades ya no caben se escalan en proporcion.
 *   - duplicateClip copia el clip tal cual, incluido su `takeGroup` y su `active`.
 *   - moveClip a otra pista conserva `takeGroup` (el grupo es local a la pista de destino).
 *   - Un id que no existe se informa con `bad_id` y la ruta del argumento (`clip_id`, `track_id`).
 *
 * v2 (STUDIO_V2.md; operaciones al final del archivo, SessionOpsV2Api):
 *   - Un clip de audio solo va en una pista 'audio' y un clip MIDI solo en una 'instrument': lo
 *     contrario lanza `bad_value` con ruta `track_id`. Los ids de clip son unicos sumando los de
 *     audio y los MIDI.
 *   - Toda nota que entra pasa por midiOps.normalizeNotes con el largo de su clip.
 *   - Los beats se acotan al fin de la sesion (1200 s con el bpm actual) y se redondean con
 *     roundBeat. Las notas sobre el tope (por clip o por sesion) lanzan `too_many`.
 *   - splitMidiClip de un clip con repeticion primero "despliega" el patron en notas: las dos
 *     mitades quedan sin repeticion y suenan igual que antes.
 *   - removeUnusedAssets conserva los audios de zonas del sampler y de congelados.
 *
 * Modulo puro: sin DOM ni import.meta.env (se prueba en scripts/verify-studio-logic.ts).
 */
import { normalizeNotes } from './midiOps.ts'
import {
  STUDIO_BEATS_PER_BAR_MAX,
  STUDIO_BEATS_PER_BAR_MIN,
  STUDIO_BPM_MAX,
  STUDIO_BPM_MIN,
  STUDIO_CLIP_GAIN_DB_MAX,
  STUDIO_CLIP_GAIN_DB_MIN,
  STUDIO_FX_PARAM_SPECS,
  STUDIO_LATENCY_OFFSET_MS_MAX,
  STUDIO_LATENCY_OFFSET_MS_MIN,
  STUDIO_MASTER_ID,
  STUDIO_MAX_ASSETS,
  STUDIO_MAX_BEAT,
  STUDIO_MAX_CLIPS_PER_TRACK,
  STUDIO_MAX_MARKERS,
  STUDIO_MAX_MIDI_CLIPS_PER_TRACK,
  STUDIO_MAX_NOTES_PER_CLIP,
  STUDIO_MAX_NOTES_PER_SESSION,
  STUDIO_MAX_SESSION_SECONDS,
  STUDIO_MAX_TRACK_NAME,
  STUDIO_MAX_TRACKS,
  STUDIO_MIDI_MIN_CLIP_BEATS,
  STUDIO_MIDI_MIN_NOTE_BEATS,
  STUDIO_MIN_CLIP_SECONDS,
  STUDIO_NOTE_EPSILON_BEATS,
  STUDIO_TIME_EPSILON_S,
  STUDIO_REVERB_DECAY_S_MAX,
  STUDIO_REVERB_DECAY_S_MIN,
  STUDIO_REVERB_RETURN_DB_MAX,
  STUDIO_REVERB_RETURN_DB_MIN,
  STUDIO_REVERB_SEND_DB_MAX,
  STUDIO_REVERB_SEND_DB_MIN,
  STUDIO_VOLUME_DB_MAX,
  STUDIO_VOLUME_DB_MIN,
  STUDIO_MAX_SESSION_CHORDS,
  STUDIO_MAX_SESSION_CHORD_NAME,
  StudioSessionError,
  beatsToSeconds,
  compareChords,
  countSessionNotes,
  defaultFx,
  findAsset,
  findClip,
  findMidiClip,
  isClipIdTaken,
  isStudioId,
  roundBeat,
  secondsToBeats,
  sortNotes,
  usedAssetIds,
  validateSession,
  type ClipLocation,
  type MidiClipLocation,
  type StudioAsset,
  type StudioClip,
  type StudioFx,
  type StudioFxType,
  type StudioMarker,
  type StudioMidiClip,
  type StudioMidiNote,
  type StudioSession,
  type StudioSessionErrorCode,
  type StudioTrack,
} from './session.ts'
import type {
  AddAssetArgs,
  AddClipArgs,
  AddInstrumentTrackArgs,
  AddMidiClipArgs,
  AddTrackArgs,
  ApplyMixSuggestionArgs,
  DeleteClipArgs,
  DuplicateClipArgs,
  DuplicateMidiClipArgs,
  MoveClipArgs,
  MoveMidiClipArgs,
  RemoveMidiClipArgs,
  RemoveTrackArgs,
  ResizeMidiClipArgs,
  SessionOpsApi,
  SessionOpsV2Api,
  SetActiveTakeArgs,
  SetClipFadesArgs,
  SetClipGainArgs,
  SetFrozenAssetArgs,
  SetInstrumentArgs,
  SetMarkersArgs,
  SetChordsArgs,
  SetTrackFxArgs,
  SnapTimeArgs,
  SplitClipArgs,
  SplitMidiClipArgs,
  TrimClipArgs,
  UpdateMasterArgs,
  UpdateMidiClipArgs,
  UpdateSessionMetaArgs,
  UpdateTrackArgs,
} from './types.ts'

// ---------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------

function fail(code: StudioSessionErrorCode, path: string, message: string): never {
  throw new StudioSessionError(code, path, message)
}

/** Acota al rango. Un numero no finito no se puede acotar: lanza. */
function clamp(value: number, min: number, max: number, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('bad_type', path, 'Se esperaba un número')
  return value < min ? min : value > max ? max : value
}

function locate(session: StudioSession, clipId: string): ClipLocation {
  const loc = findClip(session, clipId)
  if (!loc) fail('bad_id', 'clip_id', `No existe el clip "${clipId}"`)
  return loc
}

function trackIndexOf(session: StudioSession, trackId: string): number {
  const index = session.tracks.findIndex((t) => t.id === trackId)
  if (index < 0) fail('bad_id', 'track_id', `No existe la pista "${trackId}"`)
  return index
}

function replaceTrack(session: StudioSession, index: number, track: StudioTrack): StudioSession {
  const tracks = session.tracks.slice()
  tracks[index] = track
  return { ...session, tracks }
}

function replaceClip(session: StudioSession, loc: ClipLocation, clip: StudioClip): StudioSession {
  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = clip
  return replaceTrack(session, loc.trackIndex, { ...loc.track, clips })
}

function clipEnd(clip: StudioClip): number {
  return clip.startS + clip.lengthS
}

/** Fades que caben en `lengthS`; si no caben se escalan en proporcion. */
function fitFades(fadeInS: number, fadeOutS: number, lengthS: number): { fadeInS: number; fadeOutS: number } {
  const total = fadeInS + fadeOutS
  if (total <= lengthS) return { fadeInS, fadeOutS }
  const scale = lengthS / total
  const fadeIn = fadeInS * scale
  return { fadeInS: fadeIn, fadeOutS: Math.max(0, Math.min(fadeOutS * scale, lengthS - fadeIn)) }
}

function ensureNewClipId(session: StudioSession, newClipId: string): void {
  if (!isStudioId(newClipId)) fail('bad_id', 'new_clip_id', 'El id solo admite letras, números, guion y guion bajo (1 a 80)')
  // v2: los ids de clip son unicos sumando los de audio y los MIDI.
  if (isClipIdTaken(session, newClipId)) fail('duplicate_id', 'new_clip_id', `El id de clip "${newClipId}" está repetido`)
}

/** v2: un clip de audio solo va en una pista de audio. */
function ensureAudioTrack(track: StudioTrack): void {
  if (track.kind !== 'audio') fail('bad_value', 'track_id', `La pista "${track.id}" es de instrumento: no admite clips de audio`)
}

function ensureRoomForClip(track: StudioTrack): void {
  if (track.clips.length >= STUDIO_MAX_CLIPS_PER_TRACK) {
    fail('too_many', 'clips', `Una pista admite hasta ${STUDIO_MAX_CLIPS_PER_TRACK} clips`)
  }
}

/** Valida el resultado contra el contrato (lanza StudioSessionError) y lo devuelve tal cual. */
function checked(session: StudioSession): StudioSession {
  validateSession(session)
  return session
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

export function moveClip(session: StudioSession, args: MoveClipArgs): StudioSession {
  const loc = locate(session, args.clipId)
  const startS = clamp(args.startS, 0, Math.max(0, STUDIO_MAX_SESSION_SECONDS - loc.clip.lengthS), 'start_s')
  const targetIndex = args.trackId === undefined || args.trackId === loc.track.id ? loc.trackIndex : trackIndexOf(session, args.trackId)
  if (targetIndex === loc.trackIndex) {
    if (startS === loc.clip.startS) return session
    return replaceClip(session, loc, { ...loc.clip, startS })
  }
  const target = session.tracks[targetIndex]
  ensureAudioTrack(target)
  ensureRoomForClip(target)
  const moved: StudioClip = startS === loc.clip.startS ? loc.clip : { ...loc.clip, startS }
  const tracks = session.tracks.slice()
  tracks[loc.trackIndex] = { ...loc.track, clips: loc.track.clips.filter((c) => c.id !== loc.clip.id) }
  tracks[targetIndex] = { ...target, clips: [...target.clips, moved] }
  return { ...session, tracks }
}

export function trimClip(session: StudioSession, args: TrimClipArgs): StudioSession {
  const loc = locate(session, args.clipId)
  const clip = loc.clip
  const asset = findAsset(session, clip.assetId)
  if (!asset) fail('unknown_asset', 'asset_id', `El clip usa el audio "${clip.assetId}", que no está en la sesión`)
  const end = clipEnd(clip)
  let next: StudioClip
  if (args.edge === 'start') {
    // El borde izquierdo no puede ir antes del inicio del audio ni de la sesion, ni dejar el clip
    // con menos del largo minimo.
    const earliest = Math.max(0, clip.startS - clip.offsetS)
    const latest = Math.max(earliest, end - STUDIO_MIN_CLIP_SECONDS)
    const startS = clamp(args.toS, earliest, latest, 'to_s')
    if (startS === clip.startS) return session
    const delta = startS - clip.startS
    // La resta puede dar una pizca menos que el minimo por redondeo binario: el largo manda.
    const lengthS = Math.max(STUDIO_MIN_CLIP_SECONDS, end - startS)
    next = { ...clip, startS, offsetS: Math.max(0, clip.offsetS + delta), lengthS }
  } else if (args.edge === 'end') {
    const earliest = clip.startS + STUDIO_MIN_CLIP_SECONDS
    const latest = Math.max(earliest, Math.min(clip.startS + (asset.durationS - clip.offsetS), STUDIO_MAX_SESSION_SECONDS))
    const newEnd = clamp(args.toS, earliest, latest, 'to_s')
    const lengthS = Math.max(STUDIO_MIN_CLIP_SECONDS, newEnd - clip.startS)
    if (lengthS === clip.lengthS) return session
    next = { ...clip, lengthS }
  } else {
    fail('bad_value', 'edge', 'El borde debe ser "start" o "end"')
  }
  const fades = fitFades(next.fadeInS, next.fadeOutS, next.lengthS)
  return replaceClip(session, loc, { ...next, ...fades })
}

export function splitClip(session: StudioSession, args: SplitClipArgs): StudioSession {
  const loc = locate(session, args.clipId)
  const clip = loc.clip
  const atS = clamp(args.atS, 0, STUDIO_MAX_SESSION_SECONDS, 'at_s')
  const end = clipEnd(clip)
  const leftLength = atS - clip.startS
  const rightLength = end - atS
  // En el borde o fuera del clip no hay nada que dividir.
  if (leftLength < STUDIO_MIN_CLIP_SECONDS || rightLength < STUDIO_MIN_CLIP_SECONDS) return session
  ensureNewClipId(session, args.newClipId)
  ensureRoomForClip(loc.track)
  // El corte es seco: el fade de entrada queda en la mitad izquierda y el de salida en la derecha.
  const left: StudioClip = { ...clip, lengthS: leftLength, fadeInS: Math.min(clip.fadeInS, leftLength), fadeOutS: 0 }
  const right: StudioClip = {
    ...clip,
    id: args.newClipId,
    startS: atS,
    offsetS: clip.offsetS + leftLength,
    lengthS: rightLength,
    fadeInS: 0,
    fadeOutS: Math.min(clip.fadeOutS, rightLength),
  }
  const clips = loc.track.clips.slice()
  clips.splice(loc.clipIndex, 1, left, right)
  return replaceTrack(session, loc.trackIndex, { ...loc.track, clips })
}

export function duplicateClip(session: StudioSession, args: DuplicateClipArgs): StudioSession {
  const loc = locate(session, args.clipId)
  ensureNewClipId(session, args.newClipId)
  ensureRoomForClip(loc.track)
  const wanted = args.startS === undefined ? clipEnd(loc.clip) : args.startS
  const startS = clamp(wanted, 0, Math.max(0, STUDIO_MAX_SESSION_SECONDS - loc.clip.lengthS), 'start_s')
  const copy: StudioClip = { ...loc.clip, id: args.newClipId, startS }
  const clips = loc.track.clips.slice()
  clips.splice(loc.clipIndex + 1, 0, copy)
  return replaceTrack(session, loc.trackIndex, { ...loc.track, clips })
}

export function deleteClip(session: StudioSession, args: DeleteClipArgs): StudioSession {
  const loc = locate(session, args.clipId)
  return replaceTrack(session, loc.trackIndex, { ...loc.track, clips: loc.track.clips.filter((c) => c.id !== args.clipId) })
}

export function setClipFades(session: StudioSession, args: SetClipFadesArgs): StudioSession {
  const loc = locate(session, args.clipId)
  const clip = loc.clip
  let fadeInS = clip.fadeInS
  let fadeOutS = clip.fadeOutS
  if (args.fadeInS !== undefined && args.fadeOutS !== undefined) {
    fadeInS = clamp(args.fadeInS, 0, clip.lengthS, 'fade_in_s')
    fadeOutS = clamp(args.fadeOutS, 0, clip.lengthS - fadeInS, 'fade_out_s')
  } else if (args.fadeInS !== undefined) {
    // El fade que se arrastra cede ante el otro: no lo empuja.
    fadeInS = clamp(args.fadeInS, 0, Math.max(0, clip.lengthS - fadeOutS), 'fade_in_s')
  } else if (args.fadeOutS !== undefined) {
    fadeOutS = clamp(args.fadeOutS, 0, Math.max(0, clip.lengthS - fadeInS), 'fade_out_s')
  }
  if (fadeInS === clip.fadeInS && fadeOutS === clip.fadeOutS) return session
  return replaceClip(session, loc, { ...clip, fadeInS, fadeOutS })
}

export function setClipGain(session: StudioSession, args: SetClipGainArgs): StudioSession {
  const loc = locate(session, args.clipId)
  const gainDb = clamp(args.gainDb, STUDIO_CLIP_GAIN_DB_MIN, STUDIO_CLIP_GAIN_DB_MAX, 'gain_db')
  if (gainDb === loc.clip.gainDb) return session
  return replaceClip(session, loc, { ...loc.clip, gainDb })
}

export function setActiveTake(session: StudioSession, args: SetActiveTakeArgs): StudioSession {
  const loc = locate(session, args.clipId)
  const chosen = loc.clip
  const chosenEnd = clipEnd(chosen)
  let changed = false
  const clips = loc.track.clips.map((c) => {
    if (c.id === chosen.id) {
      if (c.active) return c
      changed = true
      return { ...c, active: true }
    }
    const sameGroup = chosen.takeGroup !== null && c.takeGroup === chosen.takeGroup
    // Solape estricto: dos tomas que solo se tocan en un borde no compiten.
    const overlaps = c.startS < chosenEnd && chosen.startS < clipEnd(c)
    if (sameGroup && overlaps && c.active) {
      changed = true
      return { ...c, active: false }
    }
    return c
  })
  if (!changed) return session
  return replaceTrack(session, loc.trackIndex, { ...loc.track, clips })
}

export function addClip(session: StudioSession, args: AddClipArgs): StudioSession {
  const index = trackIndexOf(session, args.trackId)
  const track = session.tracks[index]
  ensureAudioTrack(track)
  if (!findAsset(session, args.clip.assetId)) {
    fail('unknown_asset', 'asset_id', `El clip usa el audio "${args.clip.assetId}", que no está en la sesión`)
  }
  if (isClipIdTaken(session, args.clip.id)) fail('duplicate_id', 'id', `El id de clip "${args.clip.id}" está repetido`)
  ensureRoomForClip(track)
  return checked(replaceTrack(session, index, { ...track, clips: [...track.clips, args.clip] }))
}

// ---------------------------------------------------------------------------
// Pistas
// ---------------------------------------------------------------------------

export function addTrack(session: StudioSession, args: AddTrackArgs): StudioSession {
  if (session.tracks.length >= STUDIO_MAX_TRACKS) fail('too_many', 'tracks', `Una sesión admite hasta ${STUDIO_MAX_TRACKS} pistas`)
  if (session.tracks.some((t) => t.id === args.track.id)) fail('duplicate_id', 'id', `El id de pista "${args.track.id}" está repetido`)
  const tracks = session.tracks.slice()
  const at = args.index === undefined ? tracks.length : Math.round(clamp(args.index, 0, tracks.length, 'index'))
  tracks.splice(at, 0, args.track)
  return checked({ ...session, tracks })
}

export function removeTrack(session: StudioSession, args: RemoveTrackArgs): StudioSession {
  const index = trackIndexOf(session, args.trackId)
  return { ...session, tracks: session.tracks.filter((_, i) => i !== index) }
}

export function updateTrack(session: StudioSession, args: UpdateTrackArgs): StudioSession {
  const index = trackIndexOf(session, args.trackId)
  const track = session.tracks[index]
  const patch = args.patch
  const next: StudioTrack = { ...track }
  if (patch.name !== undefined) next.name = String(patch.name).trim()
  if (patch.role !== undefined) next.role = patch.role
  if (patch.volumeDb !== undefined) next.volumeDb = clamp(patch.volumeDb, STUDIO_VOLUME_DB_MIN, STUDIO_VOLUME_DB_MAX, 'volume_db')
  if (patch.pan !== undefined) next.pan = clamp(patch.pan, -1, 1, 'pan')
  if (patch.mute !== undefined) next.mute = patch.mute
  if (patch.solo !== undefined) next.solo = patch.solo
  if (patch.reverbSendDb !== undefined) {
    next.reverbSendDb = clamp(patch.reverbSendDb, STUDIO_REVERB_SEND_DB_MIN, STUDIO_REVERB_SEND_DB_MAX, 'reverb_send_db')
  }
  const same =
    next.name === track.name &&
    next.role === track.role &&
    next.volumeDb === track.volumeDb &&
    next.pan === track.pan &&
    next.mute === track.mute &&
    next.solo === track.solo &&
    next.reverbSendDb === track.reverbSendDb
  if (same) return session
  return checked(replaceTrack(session, index, next))
}

// ---------------------------------------------------------------------------
// Efectos
// ---------------------------------------------------------------------------

/** Efecto con todos sus parametros presentes y dentro de rango. */
function normalizeFx(fx: StudioFx, path: string): StudioFx {
  const specs = STUDIO_FX_PARAM_SPECS[fx.type]
  if (!specs) fail('bad_value', `${path}.type`, `Valor no admitido: "${String(fx.type)}"`)
  const source = (fx.params ?? {}) as unknown as Record<string, unknown>
  const params: Record<string, number> = {}
  for (const spec of specs) {
    const v = source[spec.key]
    params[spec.key] = v === undefined ? spec.def : clamp(v as number, spec.min, spec.max, `${path}.params.${spec.wire}`)
  }
  return { type: fx.type, bypass: fx.bypass === true, params } as unknown as StudioFx
}

function fxEqual(a: StudioFx, b: StudioFx): boolean {
  if (a.type !== b.type || a.bypass !== b.bypass) return false
  const pa = a.params as unknown as Record<string, number>
  const pb = b.params as unknown as Record<string, number>
  return STUDIO_FX_PARAM_SPECS[a.type].every((spec) => pa[spec.key] === pb[spec.key])
}

function chainEqual(a: readonly StudioFx[], b: readonly StudioFx[]): boolean {
  return a.length === b.length && a.every((fx, i) => fxEqual(fx, b[i]))
}

export function setTrackFx(session: StudioSession, args: SetTrackFxArgs): StudioSession {
  const fx = args.fx.map((item, i) => normalizeFx(item, `fx[${i}]`))
  if (args.trackId === STUDIO_MASTER_ID) {
    if (chainEqual(session.master.fx, fx)) return session
    return checked({ ...session, master: { ...session.master, fx } })
  }
  const index = trackIndexOf(session, args.trackId)
  const track = session.tracks[index]
  if (chainEqual(track.fx, fx)) return session
  return checked(replaceTrack(session, index, { ...track, fx }))
}

// ---------------------------------------------------------------------------
// Master y datos de la sesion
// ---------------------------------------------------------------------------

export function updateMaster(session: StudioSession, args: UpdateMasterArgs): StudioSession {
  const master = session.master
  const patch = args.patch
  let volumeDb = master.volumeDb
  let reverb = master.reverb
  if (patch.volumeDb !== undefined) volumeDb = clamp(patch.volumeDb, STUDIO_VOLUME_DB_MIN, STUDIO_VOLUME_DB_MAX, 'master.volume_db')
  if (patch.reverb !== undefined) {
    const decayS = clamp(patch.reverb.decayS, STUDIO_REVERB_DECAY_S_MIN, STUDIO_REVERB_DECAY_S_MAX, 'master.reverb.decay_s')
    const returnDb = clamp(patch.reverb.returnDb, STUDIO_REVERB_RETURN_DB_MIN, STUDIO_REVERB_RETURN_DB_MAX, 'master.reverb.return_db')
    if (decayS !== reverb.decayS || returnDb !== reverb.returnDb) reverb = { decayS, returnDb }
  }
  if (volumeDb === master.volumeDb && reverb === master.reverb) return session
  return { ...session, master: { ...master, volumeDb, reverb } }
}

export function updateSessionMeta(session: StudioSession, args: UpdateSessionMetaArgs): StudioSession {
  const patch = args.patch
  const next: StudioSession = { ...session }
  if (patch.title !== undefined) next.title = String(patch.title).trim()
  if (patch.songId !== undefined) next.songId = patch.songId
  if (patch.bpm !== undefined) next.bpm = clamp(patch.bpm, STUDIO_BPM_MIN, STUDIO_BPM_MAX, 'bpm')
  if (patch.beatsPerBar !== undefined) {
    next.beatsPerBar = Math.round(clamp(patch.beatsPerBar, STUDIO_BEATS_PER_BAR_MIN, STUDIO_BEATS_PER_BAR_MAX, 'beats_per_bar'))
  }
  if (patch.key !== undefined) {
    const key = patch.key === null ? '' : String(patch.key).trim()
    next.key = key === '' ? null : key
  }
  if (patch.latencyOffsetMs !== undefined) {
    next.latencyOffsetMs = clamp(patch.latencyOffsetMs, STUDIO_LATENCY_OFFSET_MS_MIN, STUDIO_LATENCY_OFFSET_MS_MAX, 'latency_offset_ms')
  }
  const same =
    next.title === session.title &&
    next.songId === session.songId &&
    next.bpm === session.bpm &&
    next.beatsPerBar === session.beatsPerBar &&
    next.key === session.key &&
    next.latencyOffsetMs === session.latencyOffsetMs
  if (same) return session
  return checked(next)
}

// ---------------------------------------------------------------------------
// Audios
// ---------------------------------------------------------------------------

function assetEqual(a: StudioAsset, b: StudioAsset): boolean {
  const sourceEqual =
    a.source === b.source ||
    (a.source !== null && b.source !== null && a.source.provider === b.source.provider && a.source.jobId === b.source.jobId && a.source.prompt === b.source.prompt)
  return (
    a.id === b.id &&
    a.file === b.file &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.channels === b.channels &&
    a.sampleRate === b.sampleRate &&
    a.durationS === b.durationS &&
    a.size === b.size &&
    sourceEqual
  )
}

export function addAsset(session: StudioSession, args: AddAssetArgs): StudioSession {
  const existing = findAsset(session, args.asset.id)
  if (existing) {
    if (assetEqual(existing, args.asset)) return session
    fail('duplicate_id', 'id', `El id de audio "${args.asset.id}" está repetido`)
  }
  if (session.assets.length >= STUDIO_MAX_ASSETS) fail('too_many', 'assets', `Una sesión admite hasta ${STUDIO_MAX_ASSETS} audios`)
  return checked({ ...session, assets: [...session.assets, args.asset] })
}

export function removeUnusedAssets(session: StudioSession): StudioSession {
  // v2: tambien cuentan las zonas del sampler y los congelados.
  const used = usedAssetIds(session)
  const assets = session.assets.filter((a) => used.has(a.id))
  if (assets.length === session.assets.length) return session
  return { ...session, assets }
}

// ---------------------------------------------------------------------------
// Asistente de mezcla
// ---------------------------------------------------------------------------

export function applyMixSuggestion(session: StudioSession, args: ApplyMixSuggestionArgs): StudioSession {
  const s = args.suggestion
  const onMaster = s.trackId === STUDIO_MASTER_ID
  if (s.target === 'volume_db') {
    return onMaster ? updateMaster(session, { patch: { volumeDb: s.value } }) : updateTrack(session, { trackId: s.trackId, patch: { volumeDb: s.value } })
  }
  if (s.target === 'pan') {
    if (onMaster) fail('bad_value', 'target', 'El master no tiene paneo')
    return updateTrack(session, { trackId: s.trackId, patch: { pan: s.value } })
  }
  if (s.target !== 'fx') fail('bad_value', 'target', 'Sugerencia no admitida')
  const type: StudioFxType = s.fxType
  if (!STUDIO_FX_PARAM_SPECS[type]) fail('bad_value', 'fx_type', `Valor no admitido: "${String(type)}"`)
  if (type === 'limiter' && !onMaster) fail('bad_fx', 'fx_type', 'El limitador solo va en el master')
  const chain = onMaster ? session.master.fx : session.tracks[trackIndexOf(session, s.trackId)].fx
  const proposed: Record<string, unknown> = {}
  for (const [key, value] of Object.entries((s.params ?? {}) as Record<string, unknown>)) {
    if (value !== undefined) proposed[key] = value
  }
  const at = chain.findIndex((fx) => fx.type === type)
  const next = chain.slice()
  if (at >= 0) {
    next[at] = { type, bypass: false, params: { ...chain[at].params, ...proposed } } as unknown as StudioFx
  } else {
    const base = defaultFx(type)
    const added = { type, bypass: false, params: { ...base.params, ...proposed } } as unknown as StudioFx
    // En el master el limitador siempre queda de ultimo.
    const limiterAt = onMaster ? next.findIndex((fx) => fx.type === 'limiter') : -1
    if (limiterAt >= 0) next.splice(limiterAt, 0, added)
    else next.push(added)
  }
  return setTrackFx(session, { trackId: s.trackId, fx: next })
}

// ---------------------------------------------------------------------------
// Rejilla
// ---------------------------------------------------------------------------

export function snapTime(session: StudioSession, args: SnapTimeArgs): number {
  const timeS = clamp(args.timeS, 0, STUDIO_MAX_SESSION_SECONDS, 'time_s')
  if (args.mode === 'off') return timeS
  const beatS = 60 / session.bpm
  const gridS = args.mode === 'bar' ? beatS * session.beatsPerBar : beatS
  if (!(gridS > 0) || !Number.isFinite(gridS)) return timeS
  const snapped = Math.round(timeS / gridS) * gridS
  // La ultima linea de la rejilla puede caer despues de los 20 minutos: se usa la anterior.
  return snapped > STUDIO_MAX_SESSION_SECONDS ? Math.floor(STUDIO_MAX_SESSION_SECONDS / gridS) * gridS : snapped
}

void ({
  moveClip,
  trimClip,
  splitClip,
  duplicateClip,
  deleteClip,
  setClipFades,
  setClipGain,
  setActiveTake,
  addTrack,
  removeTrack,
  updateTrack,
  setTrackFx,
  updateMaster,
  updateSessionMeta,
  addAsset,
  addClip,
  removeUnusedAssets,
  applyMixSuggestion,
  snapTime,
} satisfies SessionOpsApi)

// ###########################################################################
// v2: pistas de instrumento, clips MIDI, congelado y marcas (SessionOpsV2Api)
// ###########################################################################

function locateMidi(session: StudioSession, clipId: string): MidiClipLocation {
  const loc = findMidiClip(session, clipId)
  if (!loc) fail('bad_id', 'clip_id', `No existe el clip MIDI "${clipId}"`)
  return loc
}

function ensureInstrumentTrack(track: StudioTrack): void {
  if (track.kind !== 'instrument') fail('bad_value', 'track_id', `La pista "${track.id}" es de audio: no admite clips MIDI ni instrumento`)
}

function ensureRoomForMidiClip(track: StudioTrack): void {
  if (track.midiClips.length >= STUDIO_MAX_MIDI_CLIPS_PER_TRACK) {
    fail('too_many', 'midi_clips', `Una pista admite hasta ${STUDIO_MAX_MIDI_CLIPS_PER_TRACK} clips MIDI`)
  }
}

/** Ultimo beat de la sesion con el tempo actual (1200 s). */
function maxSessionBeat(session: StudioSession): number {
  return Math.min(STUDIO_MAX_BEAT, secondsToBeats(STUDIO_MAX_SESSION_SECONDS, session.bpm))
}

function replaceMidiClip(session: StudioSession, loc: MidiClipLocation, clip: StudioMidiClip): StudioSession {
  const midiClips = loc.track.midiClips.slice()
  midiClips[loc.clipIndex] = clip
  return replaceTrack(session, loc.trackIndex, { ...loc.track, midiClips })
}

/**
 * Comprueba los topes de notas. `added` es cuantas notas suma la operacion a la sesion (puede ser
 * negativo); `clipNotes` es el largo final del clip tocado.
 */
function ensureNoteRoom(session: StudioSession, clipNotes: number, added: number): void {
  if (clipNotes > STUDIO_MAX_NOTES_PER_CLIP) fail('too_many', 'notes', `Un clip MIDI admite hasta ${STUDIO_MAX_NOTES_PER_CLIP} notas`)
  if (added > 0 && countSessionNotes(session) + added > STUDIO_MAX_NOTES_PER_SESSION) {
    fail('too_many', 'notes', `La sesión admite hasta ${STUDIO_MAX_NOTES_PER_SESSION} notas`)
  }
}

function notesEqual(a: readonly StudioMidiNote[], b: readonly StudioMidiNote[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.pitch !== y.pitch || x.start !== y.start || x.length !== y.length || x.velocity !== y.velocity) return false
  }
  return true
}

/** Igualdad estructural de valores JSON (instrumentos, estado WAM). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bb = b as unknown[]
    return a.length === bb.length && a.every((v, i) => jsonEqual(v, bb[i]))
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const keys = Object.keys(ao)
  if (keys.length !== Object.keys(bo).length) return false
  return keys.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && jsonEqual(ao[k], bo[k]))
}

/**
 * Notas que suenan en el clip, relativas a su inicio, con la repeticion desplegada
 * (STUDIO_V2.md 2.4): el patron [0, loopBeats) se repite hasta el final del clip.
 */
export function expandMidiClipNotes(clip: StudioMidiClip): StudioMidiNote[] {
  if (!clip.loop || clip.loopBeats >= clip.lengthBeats - STUDIO_NOTE_EPSILON_BEATS) return sortNotes(clip.notes)
  const pattern = clip.notes.filter((n) => n.start < clip.loopBeats)
  const out: StudioMidiNote[] = []
  for (let lap = 0; lap * clip.loopBeats < clip.lengthBeats - STUDIO_NOTE_EPSILON_BEATS; lap++) {
    const offset = lap * clip.loopBeats
    for (const n of pattern) {
      const start = roundBeat(n.start + offset)
      if (start < clip.lengthBeats) out.push({ ...n, start })
    }
  }
  return normalizeNotes(out, clip.lengthBeats)
}

// ---------------------------------------------------------------------------
// Pistas de instrumento
// ---------------------------------------------------------------------------

export function addInstrumentTrack(session: StudioSession, args: AddInstrumentTrackArgs): StudioSession {
  if (args.track.kind !== 'instrument') fail('bad_value', 'kind', 'La pista debe ser de instrumento')
  if (session.tracks.length >= STUDIO_MAX_TRACKS) fail('too_many', 'tracks', `Una sesión admite hasta ${STUDIO_MAX_TRACKS} pistas`)
  if (session.tracks.some((t) => t.id === args.track.id)) fail('duplicate_id', 'id', `El id de pista "${args.track.id}" está repetido`)
  for (const clip of args.track.midiClips) {
    if (isClipIdTaken(session, clip.id)) fail('duplicate_id', 'midi_clips.id', `El id de clip "${clip.id}" está repetido`)
  }
  const added = args.track.midiClips.reduce((n, c) => n + c.notes.length, 0)
  ensureNoteRoom(session, 0, added)
  const track: StudioTrack = {
    ...args.track,
    midiClips: args.track.midiClips.map((c) => ({ ...c, notes: normalizeNotes(c.notes, c.lengthBeats) })),
  }
  const tracks = session.tracks.slice()
  const at = args.index === undefined ? tracks.length : Math.round(clamp(args.index, 0, tracks.length, 'index'))
  tracks.splice(at, 0, track)
  return checked({ ...session, tracks })
}

export function setInstrument(session: StudioSession, args: SetInstrumentArgs): StudioSession {
  const index = trackIndexOf(session, args.trackId)
  const track = session.tracks[index]
  ensureInstrumentTrack(track)
  const instrument = args.instrument
  if (!instrument || typeof instrument !== 'object') fail('not_an_object', 'instrument', 'Se esperaba un instrumento')
  if (instrument.type === 'sampler') {
    instrument.zones.forEach((zone, i) => {
      if (!findAsset(session, zone.assetId)) {
        fail('unknown_asset', `instrument.zones[${i}].asset_id`, `La zona usa el audio "${zone.assetId}", que no está en la sesión`)
      }
    })
  }
  if (jsonEqual(track.instrument, instrument)) return session
  return checked(replaceTrack(session, index, { ...track, instrument }))
}

export function setFrozenAsset(session: StudioSession, args: SetFrozenAssetArgs): StudioSession {
  const index = trackIndexOf(session, args.trackId)
  const track = session.tracks[index]
  ensureInstrumentTrack(track)
  if (args.assetId !== null && !findAsset(session, args.assetId)) {
    fail('unknown_asset', 'asset_id', `El congelado usa el audio "${args.assetId}", que no está en la sesión`)
  }
  if (track.frozenAssetId === args.assetId) return session
  return replaceTrack(session, index, { ...track, frozenAssetId: args.assetId })
}

// ---------------------------------------------------------------------------
// Clips MIDI
// ---------------------------------------------------------------------------

export function addMidiClip(session: StudioSession, args: AddMidiClipArgs): StudioSession {
  const index = trackIndexOf(session, args.trackId)
  const track = session.tracks[index]
  ensureInstrumentTrack(track)
  const c = args.clip
  if (!isStudioId(c.id)) fail('bad_id', 'id', 'El id solo admite letras, números, guion y guion bajo (1 a 80)')
  if (isClipIdTaken(session, c.id)) fail('duplicate_id', 'id', `El id de clip "${c.id}" está repetido`)
  ensureRoomForMidiClip(track)
  const maxBeat = maxSessionBeat(session)
  const lengthBeats = roundBeat(clamp(c.lengthBeats, STUDIO_MIDI_MIN_CLIP_BEATS, Math.max(STUDIO_MIDI_MIN_CLIP_BEATS, maxBeat), 'length_beats'))
  const startBeat = roundBeat(clamp(c.startBeat, 0, Math.max(0, maxBeat - lengthBeats), 'start_beat'))
  const loopBeats = roundBeat(clamp(c.loopBeats, STUDIO_MIDI_MIN_CLIP_BEATS, STUDIO_MAX_BEAT, 'loop_beats'))
  const notes = normalizeNotes(c.notes, lengthBeats)
  ensureNoteRoom(session, notes.length, notes.length)
  const clip: StudioMidiClip = { id: c.id, startBeat, lengthBeats, loop: c.loop === true, loopBeats, notes }
  return checked(replaceTrack(session, index, { ...track, midiClips: [...track.midiClips, clip] }))
}

export function updateMidiClip(session: StudioSession, args: UpdateMidiClipArgs): StudioSession {
  const loc = locateMidi(session, args.clipId)
  const clip = loc.clip
  const patch = args.patch
  const next: StudioMidiClip = { ...clip }
  if (patch.notes !== undefined) next.notes = normalizeNotes(patch.notes, clip.lengthBeats)
  if (patch.loop !== undefined) next.loop = patch.loop === true
  if (patch.loopBeats !== undefined) next.loopBeats = roundBeat(clamp(patch.loopBeats, STUDIO_MIDI_MIN_CLIP_BEATS, STUDIO_MAX_BEAT, 'loop_beats'))
  const notesSame = notesEqual(next.notes, clip.notes)
  if (notesSame && next.loop === clip.loop && next.loopBeats === clip.loopBeats) return session
  if (notesSame) next.notes = clip.notes
  else ensureNoteRoom(session, next.notes.length, next.notes.length - clip.notes.length)
  return checked(replaceMidiClip(session, loc, next))
}

export function removeMidiClip(session: StudioSession, args: RemoveMidiClipArgs): StudioSession {
  const loc = locateMidi(session, args.clipId)
  return replaceTrack(session, loc.trackIndex, { ...loc.track, midiClips: loc.track.midiClips.filter((c) => c.id !== args.clipId) })
}

export function moveMidiClip(session: StudioSession, args: MoveMidiClipArgs): StudioSession {
  const loc = locateMidi(session, args.clipId)
  const startBeat = roundBeat(clamp(args.startBeat, 0, Math.max(0, maxSessionBeat(session) - loc.clip.lengthBeats), 'start_beat'))
  const targetIndex = args.trackId === undefined || args.trackId === loc.track.id ? loc.trackIndex : trackIndexOf(session, args.trackId)
  if (targetIndex === loc.trackIndex) {
    if (startBeat === loc.clip.startBeat) return session
    return replaceMidiClip(session, loc, { ...loc.clip, startBeat })
  }
  const target = session.tracks[targetIndex]
  ensureInstrumentTrack(target)
  ensureRoomForMidiClip(target)
  const moved: StudioMidiClip = startBeat === loc.clip.startBeat ? loc.clip : { ...loc.clip, startBeat }
  const tracks = session.tracks.slice()
  tracks[loc.trackIndex] = { ...loc.track, midiClips: loc.track.midiClips.filter((c) => c.id !== loc.clip.id) }
  tracks[targetIndex] = { ...target, midiClips: [...target.midiClips, moved] }
  return { ...session, tracks }
}

export function resizeMidiClip(session: StudioSession, args: ResizeMidiClipArgs): StudioSession {
  const loc = locateMidi(session, args.clipId)
  const clip = loc.clip
  const end = clip.startBeat + clip.lengthBeats
  if (args.edge === 'end') {
    const newEnd = roundBeat(clamp(args.toBeat, clip.startBeat + STUDIO_MIDI_MIN_CLIP_BEATS, Math.max(clip.startBeat + STUDIO_MIDI_MIN_CLIP_BEATS, maxSessionBeat(session)), 'to_beat'))
    const lengthBeats = Math.max(STUDIO_MIDI_MIN_CLIP_BEATS, roundBeat(newEnd - clip.startBeat))
    if (lengthBeats === clip.lengthBeats) return session
    // Achicar quita las notas que quedan fuera; agrandar no cambia las notas.
    const notes = lengthBeats < clip.lengthBeats ? clip.notes.filter((n) => n.start < lengthBeats) : clip.notes
    return checked(replaceMidiClip(session, loc, { ...clip, lengthBeats, notes: notes.length === clip.notes.length ? clip.notes : notes }))
  }
  if (args.edge !== 'start') fail('bad_value', 'edge', 'El borde debe ser "start" o "end"')
  const startBeat = roundBeat(clamp(args.toBeat, 0, Math.max(0, end - STUDIO_MIDI_MIN_CLIP_BEATS), 'to_beat'))
  if (startBeat === clip.startBeat) return session
  const lengthBeats = Math.max(STUDIO_MIDI_MIN_CLIP_BEATS, roundBeat(end - startBeat))
  // Las notas conservan su posicion absoluta en la sesion; las que quedan antes del nuevo inicio se quitan.
  const shift = startBeat - clip.startBeat
  const shifted: StudioMidiNote[] = []
  for (const n of clip.notes) {
    const start = roundBeat(n.start - shift)
    if (start >= 0 && start < lengthBeats) shifted.push({ ...n, start })
  }
  return checked(replaceMidiClip(session, loc, { ...clip, startBeat, lengthBeats, notes: normalizeNotes(shifted, lengthBeats) }))
}

export function duplicateMidiClip(session: StudioSession, args: DuplicateMidiClipArgs): StudioSession {
  const loc = locateMidi(session, args.clipId)
  ensureNewClipId(session, args.newClipId)
  ensureRoomForMidiClip(loc.track)
  ensureNoteRoom(session, loc.clip.notes.length, loc.clip.notes.length)
  const wanted = args.startBeat === undefined ? loc.clip.startBeat + loc.clip.lengthBeats : args.startBeat
  const startBeat = roundBeat(clamp(wanted, 0, Math.max(0, maxSessionBeat(session) - loc.clip.lengthBeats), 'start_beat'))
  // Las notas son inmutables: la copia puede compartir el arreglo.
  const copy: StudioMidiClip = { ...loc.clip, id: args.newClipId, startBeat }
  const midiClips = loc.track.midiClips.slice()
  midiClips.splice(loc.clipIndex + 1, 0, copy)
  return checked(replaceTrack(session, loc.trackIndex, { ...loc.track, midiClips }))
}

export function splitMidiClip(session: StudioSession, args: SplitMidiClipArgs): StudioSession {
  const loc = locateMidi(session, args.clipId)
  const clip = loc.clip
  const at = roundBeat(clamp(args.atBeat, 0, STUDIO_MAX_BEAT, 'at_beat'))
  const cut = roundBeat(at - clip.startBeat)
  const rightLength = roundBeat(clip.lengthBeats - cut)
  // En el borde o fuera del clip no hay nada que dividir.
  if (cut < STUDIO_MIDI_MIN_CLIP_BEATS || rightLength < STUDIO_MIDI_MIN_CLIP_BEATS) return session
  ensureNewClipId(session, args.newClipId)
  ensureRoomForMidiClip(loc.track)
  const source = expandMidiClipNotes(clip)
  const leftNotes: StudioMidiNote[] = []
  const rightNotes: StudioMidiNote[] = []
  for (const n of source) {
    const end = n.start + n.length
    if (n.start >= cut) {
      rightNotes.push({ ...n, start: roundBeat(n.start - cut) })
      continue
    }
    const leftPart = roundBeat(cut - n.start)
    const rightPart = roundBeat(end - cut)
    if (rightPart < STUDIO_MIDI_MIN_NOTE_BEATS) {
      // No cruza el corte (o lo cruza menos que una nota minima): queda entera a la izquierda.
      leftNotes.push(n)
    } else if (leftPart < STUDIO_MIDI_MIN_NOTE_BEATS) {
      // Empieza casi en el corte: pasa entera a la derecha.
      rightNotes.push({ ...n, start: 0, length: rightPart })
    } else {
      // Cruza el corte: se divide en dos.
      leftNotes.push({ ...n, length: leftPart })
      rightNotes.push({ ...n, start: 0, length: rightPart })
    }
  }
  const left: StudioMidiClip = { ...clip, lengthBeats: cut, loop: false, loopBeats: cut, notes: normalizeNotes(leftNotes, cut) }
  const right: StudioMidiClip = {
    id: args.newClipId,
    startBeat: at,
    lengthBeats: rightLength,
    loop: false,
    loopBeats: rightLength,
    notes: normalizeNotes(rightNotes, rightLength),
  }
  ensureNoteRoom(session, Math.max(left.notes.length, right.notes.length), left.notes.length + right.notes.length - clip.notes.length)
  const midiClips = loc.track.midiClips.slice()
  midiClips.splice(loc.clipIndex, 1, left, right)
  return checked(replaceTrack(session, loc.trackIndex, { ...loc.track, midiClips }))
}

// ---------------------------------------------------------------------------
// Marcas
// ---------------------------------------------------------------------------

function compareMarkerOrder(a: StudioMarker, b: StudioMarker): number {
  return a.beat - b.beat || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export function setMarkers(session: StudioSession, args: SetMarkersArgs): StudioSession {
  const raw = args.markers
  if (raw.length > STUDIO_MAX_MARKERS) fail('too_many', 'markers', `La sesión admite hasta ${STUDIO_MAX_MARKERS} marcas`)
  const ids = new Set<string>()
  const markers = raw.map((m, i) => {
    if (!isStudioId(m.id)) fail('bad_id', `markers[${i}].id`, 'El id solo admite letras, números, guion y guion bajo (1 a 80)')
    if (ids.has(m.id)) fail('duplicate_id', `markers[${i}].id`, `El id de marca "${m.id}" está repetido`)
    ids.add(m.id)
    const beat = roundBeat(clamp(m.beat, 0, STUDIO_MAX_BEAT, `markers[${i}].beat`))
    if (beatsToSeconds(beat, session.bpm) > STUDIO_MAX_SESSION_SECONDS + STUDIO_TIME_EPSILON_S) {
      fail('session_too_long', `markers[${i}].beat`, 'La marca queda después de los 20 minutos que admite una sesión')
    }
    return { id: m.id, beat, label: String(m.label ?? '').trim(), kind: m.kind }
  })
  markers.sort(compareMarkerOrder)
  const current = session.markers
  const same =
    markers.length === current.length &&
    markers.every((m, i) => m.id === current[i].id && m.beat === current[i].beat && m.label === current[i].label && m.kind === current[i].kind)
  if (same) return session
  return checked({ ...session, markers })
}

/**
 * Reemplaza los acordes de referencia (STUDIO_V2.md 2.9) de una vez: un paso de deshacer. Los
 * tiempos se acotan y redondean; un nombre vacio o demasiado largo, o un acorde despues de los
 * 1200 s, lanza. Lista vacia = la sesion queda sin la clave.
 */
export function setChords(session: StudioSession, args: SetChordsArgs): StudioSession {
  const raw = args.chords
  if (raw.length > STUDIO_MAX_SESSION_CHORDS) fail('too_many', 'chords', `La sesión admite hasta ${STUDIO_MAX_SESSION_CHORDS} acordes`)
  const chords = raw.map((c, i) => {
    const name = String(c.name ?? '').trim()
    if (name.length < 1 || name.length > STUDIO_MAX_SESSION_CHORD_NAME) fail('out_of_range', `chords[${i}].name`, `El nombre del acorde debe tener entre 1 y ${STUDIO_MAX_SESSION_CHORD_NAME} caracteres`)
    const beat = roundBeat(clamp(c.beat, 0, STUDIO_MAX_BEAT, `chords[${i}].beat`))
    const lengthBeats = roundBeat(clamp(c.lengthBeats, 0, STUDIO_MAX_BEAT, `chords[${i}].length_beats`))
    if (!(lengthBeats > 0)) fail('out_of_range', `chords[${i}].length_beats`, 'El acorde debe durar más de 0 beats')
    if (beatsToSeconds(beat + lengthBeats, session.bpm) > STUDIO_MAX_SESSION_SECONDS + STUDIO_TIME_EPSILON_S) {
      fail('session_too_long', `chords[${i}].length_beats`, 'El acorde termina después de los 20 minutos que admite una sesión')
    }
    return { beat, lengthBeats, name }
  })
  chords.sort(compareChords)
  const current = session.chords ?? []
  const same = chords.length === current.length && chords.every((c, i) => c.beat === current[i].beat && c.lengthBeats === current[i].lengthBeats && c.name === current[i].name)
  if (same) return session
  if (chords.length === 0) {
    const rest = { ...session }
    delete rest.chords
    return checked(rest)
  }
  return checked({ ...session, chords })
}

void ({
  addInstrumentTrack,
  setInstrument,
  addMidiClip,
  updateMidiClip,
  removeMidiClip,
  moveMidiClip,
  resizeMidiClip,
  duplicateMidiClip,
  splitMidiClip,
  setFrozenAsset,
  setMarkers,
  setChords,
} satisfies SessionOpsV2Api)

// ###########################################################################
// Edicion de DAW sobre varios clips: portapapeles, mover, unir, recortar, silenciar y pistas
// ###########################################################################
//
// Decisiones (docs/PLAN_ESTUDIO_V2.md seccion 6; no cambian el formato de la sesion):
//   - Las operaciones reciben ids de clips de audio y MIDI mezclados (los ids son unicos entre los
//     dos). Un id que no existe se ignora: la seleccion de la interfaz puede quedar vieja un
//     instante y eso no es un error del usuario.
//   - El portapapeles guarda los clips con su posicion relativa al primero, EN SEGUNDOS (los
//     clips de audio viven en segundos y los MIDI en beats; el segundo es la base comun).
//   - Pegar pone cada clip en su pista de origen; si todo lo copiado salio de UNA pista y la pista
//     destino es compatible (audio en audio, MIDI en instrumento), en la pista destino. Un clip de
//     audio pegado es un clip nuevo: queda activo y sin grupo de tomas.
//   - Unir: los clips MIDI de una misma pista se funden en uno que va del primero al ultimo (los
//     huecos quedan en silencio y la repeticion se despliega). Los clips de audio solo se unen si
//     son trozos contiguos del mismo audio (lo que deja dividir): no se renderiza audio nuevo.
//   - Silenciar un clip de audio es `active: false` (STUDIO_V1.md: un clip inactivo no suena ni
//     se exporta). Los clips MIDI no tienen ese campo en el contrato: no se silencian.

/** Un clip copiado, con su pista de origen y su desplazamiento desde el inicio del bloque. */
export type ClipboardItem =
  | { kind: 'audio'; trackId: string; offsetS: number; clip: StudioClip }
  | { kind: 'midi'; trackId: string; offsetS: number; clip: StudioMidiClip }

/** Bloque de clips copiados: inicio y largo del bloque en la sesion de origen, en segundos. */
export interface ClipClipboard {
  items: readonly ClipboardItem[]
  startS: number
  spanS: number
}

/** Rango en segundos [inicio, fin) de un clip de audio o MIDI de la sesion. */
function clipSpanS(session: StudioSession, clipId: string): { startS: number; endS: number } | null {
  const audio = findClip(session, clipId)
  if (audio) return { startS: audio.clip.startS, endS: clipEnd(audio.clip) }
  const midi = findMidiClip(session, clipId)
  if (midi) {
    const startS = beatsToSeconds(midi.clip.startBeat, session.bpm)
    return { startS, endS: startS + beatsToSeconds(midi.clip.lengthBeats, session.bpm) }
  }
  return null
}

/** Rango en segundos que cubren los clips (los ids que no existen se ignoran), o null. */
export function clipsRangeS(session: StudioSession, clipIds: readonly string[]): { startS: number; endS: number } | null {
  let startS = Infinity
  let endS = -Infinity
  for (const id of clipIds) {
    const span = clipSpanS(session, id)
    if (!span) continue
    startS = Math.min(startS, span.startS)
    endS = Math.max(endS, span.endS)
  }
  return Number.isFinite(startS) && Number.isFinite(endS) ? { startS, endS } : null
}

/** Copia los clips al portapapeles. null si ninguno existe. */
export function copyClips(session: StudioSession, clipIds: readonly string[]): ClipClipboard | null {
  const range = clipsRangeS(session, clipIds)
  if (!range) return null
  const items: ClipboardItem[] = []
  const seen = new Set<string>()
  for (const id of clipIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const audio = findClip(session, id)
    if (audio) {
      items.push({ kind: 'audio', trackId: audio.track.id, offsetS: audio.clip.startS - range.startS, clip: audio.clip })
      continue
    }
    const midi = findMidiClip(session, id)
    if (midi) items.push({ kind: 'midi', trackId: midi.track.id, offsetS: beatsToSeconds(midi.clip.startBeat, session.bpm) - range.startS, clip: midi.clip })
  }
  // Orden estable por posicion: el pegado conserva el orden de los clips en cada pista.
  items.sort((a, b) => a.offsetS - b.offsetS)
  return { items, startS: range.startS, spanS: range.endS - range.startS }
}

export interface PasteClipsArgs {
  /** Donde cae el inicio del bloque, en segundos. */
  atS: number
  /** Pista elegida: se usa si todo lo copiado salio de una sola pista y es compatible. */
  trackId?: string | null
  /** Id nuevo para cada clip pegado. */
  newClipId: (kind: 'audio' | 'midi') => string
}

function trackAccepts(track: StudioTrack, kind: 'audio' | 'midi'): boolean {
  return kind === 'audio' ? track.kind === 'audio' : track.kind === 'instrument'
}

/** Pega el bloque copiado (ver las decisiones arriba). Devuelve la sesion y los ids nuevos. */
export function pasteClips(session: StudioSession, clipboard: ClipClipboard, args: PasteClipsArgs): { session: StudioSession; clipIds: string[] } {
  const atS = clamp(args.atS, 0, STUDIO_MAX_SESSION_SECONDS, 'at_s')
  const sources = new Set(clipboard.items.map((item) => item.trackId))
  const picked = args.trackId ? session.tracks.find((t) => t.id === args.trackId) : undefined
  const pickedFits = picked !== undefined && sources.size === 1 && clipboard.items.every((item) => trackAccepts(picked, item.kind))
  let next = session
  const clipIds: string[] = []
  for (const item of clipboard.items) {
    const source = next.tracks.find((t) => t.id === item.trackId)
    const track = pickedFits ? picked : source && trackAccepts(source, item.kind) ? source : picked && trackAccepts(picked, item.kind) ? picked : undefined
    if (!track) fail('bad_id', 'track_id', `La pista del clip copiado ya no existe: elige una pista ${item.kind === 'audio' ? 'de audio' : 'de instrumento'} para pegar`)
    const id = args.newClipId(item.kind)
    const startS = atS + item.offsetS
    if (item.kind === 'audio') {
      const lengthS = item.clip.lengthS
      const clip: StudioClip = { ...item.clip, id, startS: Math.max(0, Math.min(startS, STUDIO_MAX_SESSION_SECONDS - lengthS)), takeGroup: null, active: true }
      next = addClip(next, { trackId: track.id, clip })
    } else {
      next = addMidiClip(next, { trackId: track.id, clip: { ...item.clip, id, startBeat: secondsToBeats(startS, next.bpm) } })
    }
    clipIds.push(id)
  }
  return { session: next, clipIds }
}

/** Donde pegar y con que cursor seguir: el cabezal si se movio; si no, detras del ultimo pegado. */
export interface PasteCursor {
  /** Cabezal en el momento de copiar o del ultimo pegado. */
  playheadS: number
  /** Donde cae el siguiente pegado si el cabezal no se mueve. */
  nextS: number
}

/** Cursor de pegado recien copiado: el primer pegado va justo despues del bloque original. */
export function pasteCursorAfterCopy(clipboard: ClipClipboard, playheadS: number): PasteCursor {
  return { playheadS, nextS: clipboard.startS + clipboard.spanS }
}

/**
 * Posicion del pegado. Si el cabezal se movio desde que se copio (o desde el ultimo pegado) se
 * pega en el cabezal; si no, detras del pegado anterior: Ctrl+V repetido encadena copias.
 */
export function pastePosition(clipboard: ClipClipboard, cursor: PasteCursor, playheadS: number): { atS: number; cursor: PasteCursor } {
  const moved = Math.abs(playheadS - cursor.playheadS) > STUDIO_TIME_EPSILON_S
  const atS = Math.max(0, moved ? playheadS : cursor.nextS)
  return { atS, cursor: { playheadS, nextS: atS + clipboard.spanS } }
}

/** Borra los clips (audio y MIDI). */
export function deleteClips(session: StudioSession, clipIds: readonly string[]): StudioSession {
  const ids = new Set(clipIds)
  let changed = false
  const tracks = session.tracks.map((track) => {
    const clips = track.clips.filter((c) => !ids.has(c.id))
    const midiClips = track.midiClips.filter((c) => !ids.has(c.id))
    if (clips.length === track.clips.length && midiClips.length === track.midiClips.length) return track
    changed = true
    return { ...track, clips, midiClips }
  })
  return changed ? { ...session, tracks } : session
}

/**
 * Mueve los clips `deltaS` segundos en su misma pista. El desplazamiento se acota para que el
 * bloque no salga de la sesion: los clips conservan su distancia entre si.
 */
export function moveClipsBy(session: StudioSession, clipIds: readonly string[], deltaS: number): StudioSession {
  let delta = clamp(deltaS, -STUDIO_MAX_SESSION_SECONDS, STUDIO_MAX_SESSION_SECONDS, 'delta_s')
  const range = clipsRangeS(session, clipIds)
  if (!range) return session
  delta = Math.max(delta, -range.startS)
  delta = Math.min(delta, Math.max(0, STUDIO_MAX_SESSION_SECONDS - range.endS))
  if (Math.abs(delta) < 1e-9) return session
  let next = session
  for (const id of new Set(clipIds)) {
    const audio = findClip(next, id)
    if (audio) {
      next = moveClip(next, { clipId: id, startS: audio.clip.startS + delta })
      continue
    }
    const midi = findMidiClip(next, id)
    if (midi) next = moveMidiClip(next, { clipId: id, startBeat: midi.clip.startBeat + secondsToBeats(delta, next.bpm) })
  }
  return next
}

/** true si `b` sigue a `a` sin hueco dentro del mismo audio (dos mitades de una division). */
function audioContinues(a: StudioClip, b: StudioClip): boolean {
  return (
    a.assetId === b.assetId &&
    a.gainDb === b.gainDb &&
    a.active === b.active &&
    a.takeGroup === b.takeGroup &&
    Math.abs(b.startS - clipEnd(a)) <= STUDIO_TIME_EPSILON_S &&
    Math.abs(b.offsetS - (a.offsetS + a.lengthS)) <= STUDIO_TIME_EPSILON_S
  )
}

/**
 * Une los clips elegidos de cada pista (ver las decisiones arriba). Devuelve la sesion (la misma
 * si no hubo nada que unir) y los ids de los clips que quedaron de la union.
 */
export function joinClips(session: StudioSession, clipIds: readonly string[]): { session: StudioSession; clipIds: string[] } {
  const ids = new Set(clipIds)
  let next = session
  const joined: string[] = []
  for (const track of session.tracks) {
    if (track.kind === 'instrument') {
      const picked = track.midiClips.filter((c) => ids.has(c.id)).sort((a, b) => a.startBeat - b.startBeat || (a.id < b.id ? -1 : 1))
      if (picked.length < 2) continue
      const first = picked[0]
      const endBeat = Math.max(...picked.map((c) => c.startBeat + c.lengthBeats))
      const lengthBeats = roundBeat(endBeat - first.startBeat)
      const notes = normalizeNotes(
        picked.flatMap((c) => expandMidiClipNotes(c).map((n) => ({ ...n, start: roundBeat(n.start + c.startBeat - first.startBeat) }))),
        lengthBeats,
      )
      const before = picked.reduce((sum, c) => sum + c.notes.length, 0)
      ensureNoteRoom(next, notes.length, notes.length - before)
      const merged: StudioMidiClip = { id: first.id, startBeat: first.startBeat, lengthBeats, loop: false, loopBeats: lengthBeats, notes }
      const drop = new Set(picked.slice(1).map((c) => c.id))
      const index = next.tracks.findIndex((t) => t.id === track.id)
      const current = next.tracks[index]
      next = replaceTrack(next, index, { ...current, midiClips: current.midiClips.filter((c) => !drop.has(c.id)).map((c) => (c.id === first.id ? merged : c)) })
      joined.push(first.id)
      continue
    }
    const picked = track.clips.filter((c) => ids.has(c.id)).sort((a, b) => a.startS - b.startS)
    if (picked.length < 2) continue
    const index = next.tracks.findIndex((t) => t.id === track.id)
    let clips = next.tracks[index].clips
    let run: StudioClip = picked[0]
    const flush = (merged: StudioClip, original: StudioClip) => {
      if (merged === original) return
      clips = clips.map((c) => (c.id === merged.id ? merged : c))
      joined.push(merged.id)
    }
    let runStart = picked[0]
    for (const clip of picked.slice(1)) {
      if (audioContinues(run, clip)) {
        run = { ...run, lengthS: run.lengthS + clip.lengthS, fadeOutS: clip.fadeOutS }
        clips = clips.filter((c) => c.id !== clip.id)
      } else {
        flush(run, runStart)
        run = clip
        runStart = clip
      }
    }
    flush(run, runStart)
    if (clips !== next.tracks[index].clips) next = replaceTrack(next, index, { ...next.tracks[index], clips })
  }
  return { session: next === session ? session : checked(next), clipIds: joined }
}

/**
 * Recorta el inicio (`edge: 'start'`) o el final de cada clip al tiempo `atS`. Solo los clips que
 * el tiempo cruza (estrictamente dentro): el cabezal fuera del clip no lo toca.
 */
export function trimClipsAt(session: StudioSession, clipIds: readonly string[], edge: 'start' | 'end', atS: number): StudioSession {
  const at = clamp(atS, 0, STUDIO_MAX_SESSION_SECONDS, 'at_s')
  let next = session
  for (const id of new Set(clipIds)) {
    const audio = findClip(next, id)
    if (audio) {
      if (at > audio.clip.startS + STUDIO_MIN_CLIP_SECONDS && at < clipEnd(audio.clip) - STUDIO_MIN_CLIP_SECONDS) next = trimClip(next, { clipId: id, edge, toS: at })
      continue
    }
    const midi = findMidiClip(next, id)
    if (!midi) continue
    const beat = secondsToBeats(at, next.bpm)
    const { startBeat, lengthBeats } = midi.clip
    if (beat > startBeat + STUDIO_MIDI_MIN_CLIP_BEATS && beat < startBeat + lengthBeats - STUDIO_MIDI_MIN_CLIP_BEATS) next = resizeMidiClip(next, { clipId: id, edge, toBeat: beat })
  }
  return next
}

/** Fundido de entrada (del inicio a `atS`) o de salida (de `atS` al final) en los clips de audio que `atS` cruza. */
export function fadeClipsAt(session: StudioSession, clipIds: readonly string[], edge: 'in' | 'out', atS: number): StudioSession {
  const at = clamp(atS, 0, STUDIO_MAX_SESSION_SECONDS, 'at_s')
  let next = session
  for (const id of new Set(clipIds)) {
    const audio = findClip(next, id)
    if (!audio || !(at > audio.clip.startS && at < clipEnd(audio.clip))) continue
    next = edge === 'in' ? setClipFades(next, { clipId: id, fadeInS: at - audio.clip.startS }) : setClipFades(next, { clipId: id, fadeOutS: clipEnd(audio.clip) - at })
  }
  return next
}

/**
 * Silencia o vuelve a hacer sonar los clips de audio: si alguno suena, todos se silencian; si
 * ninguno suena, todos vuelven a sonar (con setActiveTake: en un grupo de tomas, la que vuelve
 * apaga a las que se le solapan). Los clips MIDI se ignoran.
 */
export function toggleClipsActive(session: StudioSession, clipIds: readonly string[]): StudioSession {
  const audio = [...new Set(clipIds)].map((id) => findClip(session, id)).filter((loc): loc is ClipLocation => loc !== null)
  if (audio.length === 0) return session
  const silence = audio.some((loc) => loc.clip.active)
  let next = session
  for (const { clip } of audio) {
    if (silence) {
      const loc = findClip(next, clip.id)
      if (loc && loc.clip.active) next = replaceClip(next, loc, { ...loc.clip, active: false })
    } else {
      next = setActiveTake(next, { clipId: clip.id })
    }
  }
  return next
}

export interface DuplicateTrackArgs {
  trackId: string
  newTrackId: string
  /** Id nuevo para cada clip de la copia. */
  newClipId: (kind: 'audio' | 'midi') => string
}

/** Copia la pista entera (instrumento, mezcla, efectos y clips con ids nuevos) justo debajo de ella. */
export function duplicateTrack(session: StudioSession, args: DuplicateTrackArgs): StudioSession {
  const index = trackIndexOf(session, args.trackId)
  const track = session.tracks[index]
  if (session.tracks.length >= STUDIO_MAX_TRACKS) fail('too_many', 'tracks', `Una sesión admite hasta ${STUDIO_MAX_TRACKS} pistas`)
  if (session.tracks.some((t) => t.id === args.newTrackId)) fail('duplicate_id', 'id', `El id de pista "${args.newTrackId}" está repetido`)
  ensureNoteRoom(session, 0, track.midiClips.reduce((n, c) => n + c.notes.length, 0))
  const suffix = ' copia'
  const copy: StudioTrack = {
    ...track,
    id: args.newTrackId,
    name: `${track.name.slice(0, STUDIO_MAX_TRACK_NAME - suffix.length)}${suffix}`,
    solo: false,
    clips: track.clips.map((c) => ({ ...c, id: args.newClipId('audio') })),
    midiClips: track.midiClips.map((c) => ({ ...c, id: args.newClipId('midi') })),
  }
  const tracks = session.tracks.slice()
  tracks.splice(index + 1, 0, copy)
  return checked({ ...session, tracks })
}

/** Mueve una pista a otra posicion (acotada a la lista). */
export function moveTrack(session: StudioSession, args: { trackId: string; toIndex: number }): StudioSession {
  const index = trackIndexOf(session, args.trackId)
  const to = Math.round(clamp(args.toIndex, 0, session.tracks.length - 1, 'to_index'))
  if (to === index) return session
  const tracks = session.tracks.slice()
  const [track] = tracks.splice(index, 1)
  tracks.splice(to, 0, track)
  return { ...session, tracks }
}
