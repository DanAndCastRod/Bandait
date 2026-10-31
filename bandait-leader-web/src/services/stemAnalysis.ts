/**
 * Analisis con IA de una cancion (Worker bandait-stems, Music AI). Contrato en
 * bandait-stems-worker/README.md:
 *   POST /v1/bands/{band}/songs/{song}/analysis   cuerpo = mezcla WAV; 202 {status:"STARTED", job_id}
 *   GET  /v1/bands/{band}/songs/{song}/analysis   {status:"STARTED"} | {status:"SUCCEEDED", draft, created_at}
 *                                                  | {status:"FAILED", error} | 404 no_analysis
 * Solo Owner y MusicDirector (tambien para leer el borrador). El borrador queda guardado por
 * cancion en R2: lo puede haber lanzado el lider desde el portatil.
 *
 * Modulo sin DOM: la URL, el token y `fetch` llegan en el CloudTarget (ver stemCloud.ts).
 */
import { StemCloudError, authHeaders, cloudErrorMessage, failFrom, send, songUrl, type CloudTarget } from './stemCloud.ts'
import type { SectionKind, SongSection } from '../types/hub.ts'

export interface DraftSection {
  kind: SectionKind
  label: string
  bars: number
  start_bar: number
  chordpro: string
  cue_text: string | null
}

export interface AnalysisDraft {
  source: string
  bpm: number | null
  key: string | null
  beats_per_bar: number
  sections: DraftSection[]
  lyrics_unplaced: string[]
  notes: string[]
}

export type AnalysisState =
  | { status: 'none' }
  | { status: 'STARTED'; jobId: string | null }
  | { status: 'SUCCEEDED'; draft: AnalysisDraft; createdAt: string | null }
  | { status: 'FAILED'; error: string }

/** Cada cuanto se consulta y cuanto se espera como maximo (Music AI tarda 1-3 min). */
export const ANALYSIS_POLL_MS = 5000
export const ANALYSIS_TIMEOUT_MS = 6 * 60 * 1000
/** Limite del Worker para la mezcla (95 MB). */
export const ANALYSIS_MAX_BYTES = 95 * 1024 * 1024

const SECTION_KINDS: readonly SectionKind[] = ['intro', 'verse', 'pre_chorus', 'chorus', 'bridge', 'solo', 'interlude', 'outro', 'break', 'custom']

const ANALYSIS_MESSAGES: Record<string, string> = {
  analysis_unavailable: 'El análisis con IA no está disponible en este momento. Reintenta más tarde.',
  analysis_auth_failed: 'El servicio de análisis rechazó la conexión de Bandait. Avísale a quien administra Bandait.',
  analysis_failed: 'El servicio de análisis falló. Reintenta en unos minutos.',
  analysis_upload_failed: 'No se pudo enviar la mezcla al servicio de análisis. Reintenta.',
  not_an_editor: 'Solo el Owner o el Director musical de la banda pueden analizar canciones con IA.',
  not_a_member: 'No eres integrante de esta banda en la nube.',
  file_too_large: 'La mezcla supera los 95 MB que admite el análisis.',
  not_audio: 'El análisis solo acepta audio.',
  length_required: 'El navegador no informó el tamaño de la mezcla. Reintenta.',
  timeout: 'El análisis tarda más de lo normal. Vuelve a abrirlo más tarde: el resultado queda guardado en la nube.',
  bad_draft: 'La nube devolvió un borrador que el hub no entiende.',
}

/** Mensaje en espanol para un error del analisis (codigo del Worker o de red). */
export function analysisErrorMessage(code: string, status = 0): string {
  if (ANALYSIS_MESSAGES[code]) return ANALYSIS_MESSAGES[code]
  if (status === 503) return ANALYSIS_MESSAGES.analysis_unavailable
  if (status === 502 && code.startsWith('analysis_')) return ANALYSIS_MESSAGES.analysis_failed
  if (status === 403) return ANALYSIS_MESSAGES.not_an_editor
  if (status === 413) return ANALYSIS_MESSAGES.file_too_large
  if (status === 415) return ANALYSIS_MESSAGES.not_audio
  return cloudErrorMessage(code, status)
}

function analysisError(err: StemCloudError): StemCloudError {
  return new StemCloudError(err.code, err.status, analysisErrorMessage(err.code, err.status))
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** Valida el borrador recibido (defensivo: viene de otro servicio). */
export function parseDraft(raw: unknown): AnalysisDraft {
  if (typeof raw !== 'object' || raw === null) throw new StemCloudError('bad_draft', 200, ANALYSIS_MESSAGES.bad_draft)
  const d = raw as Record<string, unknown>
  if (!Array.isArray(d.sections)) throw new StemCloudError('bad_draft', 200, ANALYSIS_MESSAGES.bad_draft)
  const sections: DraftSection[] = []
  let nextBar = 1
  for (const s of d.sections) {
    if (typeof s !== 'object' || s === null) continue
    const e = s as Record<string, unknown>
    const bars = typeof e.bars === 'number' && Number.isInteger(e.bars) && e.bars >= 1 ? e.bars : null
    if (bars === null) continue
    const kind = SECTION_KINDS.includes(e.kind as SectionKind) ? (e.kind as SectionKind) : 'custom'
    const startBar = typeof e.start_bar === 'number' && Number.isInteger(e.start_bar) && e.start_bar >= 1 ? e.start_bar : nextBar
    sections.push({
      kind,
      label: str(e.label).trim().slice(0, 60) || 'Sección',
      bars,
      start_bar: startBar,
      chordpro: str(e.chordpro),
      cue_text: typeof e.cue_text === 'string' ? e.cue_text : null,
    })
    nextBar = startBar + bars
  }
  const bpm = typeof d.bpm === 'number' && Number.isFinite(d.bpm) && d.bpm > 0 ? d.bpm : null
  const bpb = typeof d.beats_per_bar === 'number' && Number.isInteger(d.beats_per_bar) && d.beats_per_bar >= 1 ? d.beats_per_bar : 4
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [])
  return {
    source: str(d.source, 'desconocido'),
    bpm,
    key: typeof d.key === 'string' && d.key.trim() ? d.key.trim() : null,
    beats_per_bar: bpb,
    sections,
    lyrics_unplaced: strings(d.lyrics_unplaced),
    notes: strings(d.notes),
  }
}

/**
 * Secciones del formulario a partir del borrador. Ids nuevos (es otra estructura). `cue_text`
 * null en el borrador significa "sin texto propuesto": queda el aviso por defecto segun el tipo.
 */
export function draftToSongSections(draft: AnalysisDraft, newId: () => string): SongSection[] {
  return draft.sections.map((s) => {
    const sec: SongSection = { id: newId(), kind: s.kind, label: s.label, bars: s.bars, chordpro: s.chordpro.replace(/\s+$/, '') }
    if (typeof s.cue_text === 'string' && s.cue_text.trim()) sec.cueText = s.cue_text.trim()
    return sec
  })
}

/** Estado del ultimo analisis de la cancion (404 no_analysis = 'none'). */
export async function getAnalysis(target: CloudTarget, songId: string): Promise<AnalysisState> {
  const headers = await authHeaders(target)
  const res = await send(target, `${songUrl(target, songId)}/analysis`, { method: 'GET', headers, cache: 'no-store' })
  if (res.status === 404) {
    const err = await failFrom(res)
    if (err.code === 'no_analysis' || err.code === '') return { status: 'none' }
    throw analysisError(err)
  }
  if (!res.ok) throw analysisError(await failFrom(res))
  let body: Record<string, unknown>
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    throw new StemCloudError('bad_response', res.status)
  }
  const status = str(body.status)
  if (status === 'SUCCEEDED') return { status: 'SUCCEEDED', draft: parseDraft(body.draft), createdAt: typeof body.created_at === 'string' ? body.created_at : null }
  if (status === 'FAILED') return { status: 'FAILED', error: str(body.error).trim() || 'El servicio de análisis no pudo analizar la canción.' }
  // STARTED, QUEUED u otro estado intermedio de Music AI: sigue en curso.
  return { status: 'STARTED', jobId: typeof body.job_id === 'string' ? body.job_id : null }
}

/** Sube la mezcla y lanza el analisis (202). */
export async function startAnalysis(target: CloudTarget, songId: string, wav: Blob): Promise<{ jobId: string | null }> {
  if (wav.size > ANALYSIS_MAX_BYTES) throw new StemCloudError('file_too_large', 413, ANALYSIS_MESSAGES.file_too_large)
  const headers = await authHeaders(target)
  headers['Content-Type'] = 'audio/wav'
  const res = await send(target, `${songUrl(target, songId)}/analysis`, { method: 'POST', headers, body: wav })
  if (!res.ok) throw analysisError(await failFrom(res))
  try {
    const body = (await res.json()) as { job_id?: unknown }
    return { jobId: typeof body.job_id === 'string' ? body.job_id : null }
  } catch {
    return { jobId: null }
  }
}
