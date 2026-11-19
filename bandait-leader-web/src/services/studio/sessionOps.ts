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
 * Modulo puro: sin DOM ni import.meta.env (se prueba en scripts/verify-studio-logic.ts).
 */
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
  STUDIO_MAX_CLIPS_PER_TRACK,
  STUDIO_MAX_SESSION_SECONDS,
  STUDIO_MAX_TRACKS,
  STUDIO_MIN_CLIP_SECONDS,
  STUDIO_REVERB_DECAY_S_MAX,
  STUDIO_REVERB_DECAY_S_MIN,
  STUDIO_REVERB_RETURN_DB_MAX,
  STUDIO_REVERB_RETURN_DB_MIN,
  STUDIO_REVERB_SEND_DB_MAX,
  STUDIO_REVERB_SEND_DB_MIN,
  STUDIO_VOLUME_DB_MAX,
  STUDIO_VOLUME_DB_MIN,
  StudioSessionError,
  defaultFx,
  findAsset,
  findClip,
  isStudioId,
  validateSession,
  type ClipLocation,
  type StudioAsset,
  type StudioClip,
  type StudioFx,
  type StudioFxType,
  type StudioSession,
  type StudioSessionErrorCode,
  type StudioTrack,
} from './session.ts'
import type {
  AddAssetArgs,
  AddClipArgs,
  AddTrackArgs,
  ApplyMixSuggestionArgs,
  DeleteClipArgs,
  DuplicateClipArgs,
  MoveClipArgs,
  RemoveTrackArgs,
  SessionOpsApi,
  SetActiveTakeArgs,
  SetClipFadesArgs,
  SetClipGainArgs,
  SetTrackFxArgs,
  SnapTimeArgs,
  SplitClipArgs,
  TrimClipArgs,
  UpdateMasterArgs,
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
  if (findClip(session, newClipId)) fail('duplicate_id', 'new_clip_id', `El id de clip "${newClipId}" está repetido`)
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
  if (!findAsset(session, args.clip.assetId)) {
    fail('unknown_asset', 'asset_id', `El clip usa el audio "${args.clip.assetId}", que no está en la sesión`)
  }
  if (findClip(session, args.clip.id)) fail('duplicate_id', 'id', `El id de clip "${args.clip.id}" está repetido`)
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
  const used = new Set<string>()
  for (const track of session.tracks) for (const clip of track.clips) used.add(clip.assetId)
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
