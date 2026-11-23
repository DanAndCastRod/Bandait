import React, { useEffect, useRef, useState } from 'react'
import { Activity, Check, Headphones, MessageSquare, RefreshCw, RotateCcw, Send, Sparkles, X } from 'lucide-react'
import { StemCloudError } from '../../services/stemCloud'
import {
  applyPendingCommand,
  allSettled,
  bulkApplicable,
  isDestructiveCommand,
  prepareToolCalls,
  rejectPendingCommand,
  toolResultsMessage,
  type PendingAssistantCommand,
} from '../../services/studio/assistantTools'
import {
  appendModelReply,
  appendUserMessage,
  CHAT_MAX_USER_TEXT,
  chatRequestForSession,
  estimateText,
  estimateV2,
  fitSessionSummary,
  formatUsd,
  jobErrorMessage,
  resumeJobV2,
  runJobV2,
} from '../../services/studio/jobs'
import { secondsToBeats } from '../../services/studio/session'
import type { ChatJobRequest, CommandContext, StudioChatListen, StudioChatMessage, StudioChatToolCall, StudioJobEstimateV2, StudioJobStateV2 } from '../../services/studio/types'
import { StudioChatMarkdown } from './StudioChatMarkdown'
import type { StudioRegistry } from './studioCommandHandlers'
import { useStudio, type StudioController } from './studioState'

type ChatSucceeded = Extract<StudioJobStateV2, { status: 'SUCCEEDED'; kind: 'chat' }>

type Phase =
  | { kind: 'idle' }
  | { kind: 'quoting' }
  /** Primer mensaje de la conversacion: se muestra el costo por mensaje y se pide confirmar. */
  | { kind: 'confirm'; outgoing: StudioChatMessage[]; estimate: StudioJobEstimateV2 }
  | { kind: 'running' }
  | { kind: 'failed'; title: string; message: string; outgoing: StudioChatMessage[] | null }
  /** El trabajo se lanzo (y se cobro) pero su respuesta no llego: se consulta, no se relanza. */
  | { kind: 'pending'; jobId: string; message: string; outgoing: StudioChatMessage[] }

/** Llamadas de la ultima respuesta del asistente que esperan decision. */
interface Proposal {
  calls: StudioChatToolCall[]
  pendings: PendingAssistantCommand[]
}

const ASSISTANT_CTX = { source: 'assistant' } as const

/** true si el ultimo mensaje es del usuario y lleva un fragmento para escuchar. */
function lastHasListen(messages: readonly StudioChatMessage[]): boolean {
  const last = messages[messages.length - 1]
  return last?.role === 'user' && last.audio !== undefined
}

/** La conversacion sin fragmentos (cuando el Worker no escucha). */
function withoutListen(messages: readonly StudioChatMessage[]): StudioChatMessage[] {
  return messages.map((m) => (m.role === 'user' && m.audio ? { role: 'user', text: m.text } : m))
}

function failureOf(err: unknown): { title: string; message: string } {
  if (err instanceof StemCloudError) {
    const message = jobErrorMessage(err)
    if (err.code === 'provider_unavailable') return { title: 'PROVEEDOR NO DISPONIBLE', message }
    if (err.code === 'quota_exceeded' || err.status === 429) return { title: 'CUOTA DEL MES AGOTADA', message }
    if (err.status === 401) return { title: 'SIN SESIÓN DE NUBE', message }
    if (err.status === 403) return { title: 'SIN PERMISO', message }
  }
  return { title: 'EL ASISTENTE FALLÓ', message: jobErrorMessage(err) }
}

const STATUS_TEXT: Record<PendingAssistantCommand['status'], string> = {
  pending: 'PROPUESTO',
  applied: 'APLICADO · CTRL+Z LO DESHACE',
  rejected: 'DESCARTADO',
  failed: 'NO SE APLICÓ',
}

interface Props {
  controller: StudioController
  registry: StudioRegistry | null
  /** Contexto activo de los comandos (timeline, piano_roll, mixer), para el resumen. */
  commandContext: () => CommandContext
  canRun: boolean
}

/**
 * Chat del asistente del Estudio (STUDIO_V2.md 4.3). Manda la conversacion y un RESUMEN de la
 * sesion (nunca audio ni notas). Cada llamada a herramienta que devuelve el modelo se muestra
 * como cambio propuesto con su descripcion: el usuario lo aplica (un paso de deshacer, por el
 * registro de comandos) o lo descarta. Cuando todos estan decididos, los resultados viajan en el
 * turno siguiente. Nada se aplica sin que el usuario lo acepte.
 */
export const StudioChatPanel: React.FC<Props> = ({ controller, registry, commandContext, canRun }) => {
  const snap = useStudio(controller)
  const [messages, setMessages] = useState<StudioChatMessage[]>([])
  const [proposal, setProposal] = useState<Proposal | null>(null)
  /** Descripcion legible de cada llamada ya decidida, por call_id (para el historial). */
  const [descriptions, setDescriptions] = useState<Readonly<Record<string, string>>>({})
  const [draft, setDraft] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  /** El costo por mensaje se confirma una vez por conversacion. */
  const [approved, setApproved] = useState<StudioJobEstimateV2 | null>(null)
  const [spentUsd, setSpentUsd] = useState(0)
  const [applying, setApplying] = useState(false)
  /** MEDIR MEZCLA (gratis, en este equipo) y ESCUCHAR FRAGMENTO (STUDIO_V2.md 4.3.5). */
  const [measure, setMeasure] = useState<{ busy: boolean; note: string | null }>({ busy: false, note: null })
  const [listenAvailable, setListenAvailable] = useState(false)
  const [listen, setListen] = useState<{ busy: boolean; attached: StudioChatListen | null; error: string | null }>({ busy: false, attached: null, error: null })
  const abortRef = useRef<AbortController | null>(null)
  const logRef = useRef<HTMLOListElement>(null)
  const confirmCancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [messages, proposal, phase.kind])

  useEffect(() => {
    if (phase.kind === 'confirm') confirmCancelRef.current?.focus({ preventScroll: true })
  }, [phase.kind])

  const busy = phase.kind === 'quoting' || phase.kind === 'running'
  const waitingDecision = proposal !== null && !allSettled(proposal.pendings)
  const last = messages[messages.length - 1]
  const canContinue = last?.role === 'tool'

  const buildRequest = (outgoing: StudioChatMessage[]): ChatJobRequest => {
    const s = controller.snapshot()
    // Con la cancion ligada (acordes sin letra) y la ultima medicion de mezcla (STUDIO_V2.md 4.3.2).
    const summary = fitSessionSummary(
      s.session,
      {
        playheadBeat: secondsToBeats(controller.engine.position(), s.session.bpm),
        selection: { trackId: s.selectedTrackId, clipIds: s.selectedClipId ? [s.selectedClipId] : [], context: commandContext() },
      },
      controller.chatExtras(),
    )
    return chatRequestForSession(outgoing, summary)
  }

  const receive = (request: ChatJobRequest, final: StudioJobStateV2) => {
    if (final.status === 'FAILED') {
      if (final.resumable) {
        setPhase({ kind: 'pending', jobId: final.jobId, message: final.error, outgoing: request.messages })
        return
      }
      setPhase({ kind: 'failed', title: 'EL ASISTENTE FALLÓ', message: final.error, outgoing: request.messages })
      return
    }
    if (final.status !== 'SUCCEEDED' || final.kind !== 'chat') return
    const reply = final as ChatSucceeded
    const next = appendModelReply(request.messages, reply)
    setMessages(next)
    setSpentUsd((value) => value + (reply.costUsd ?? 0))
    if (reply.toolCalls.length > 0 && registry) {
      const pendings = prepareToolCalls(reply.toolCalls, registry, controller.snapshot().session)
      setProposal({ calls: reply.toolCalls, pendings })
      settleIfDone(next, { calls: reply.toolCalls, pendings })
    } else {
      setProposal(null)
    }
    setPhase({ kind: 'idle' })
  }

  const launch = async (outgoing: StudioChatMessage[]) => {
    const cloud = controller.cloud
    if (!cloud) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const request = buildRequest(outgoing)
    let launched: string | null = null
    setPhase({ kind: 'running' })
    try {
      const final = await runJobV2(cloud, controller.sessionId, request, {
        signal: ctrl.signal,
        onStarted: (jobId) => {
          launched = jobId
        },
      })
      if (!final || ctrl.signal.aborted) return
      receive(request, final)
    } catch (err) {
      if (ctrl.signal.aborted) return
      const network = err instanceof StemCloudError && err.code === 'network'
      if (launched && network) {
        setPhase({ kind: 'pending', jobId: launched, message: 'Se perdió la conexión con la nube. Si el mensaje alcanzó a enviarse, la respuesta sigue en la nube: consúltala antes de reenviar.', outgoing: request.messages })
        return
      }
      setPhase({ kind: 'failed', ...failureOf(err), outgoing: listenRefused(err, outgoing) })
    }
  }

  /** Si el Worker no escucha (listen_disabled), se esconde el boton y el reintento va sin audio. */
  const listenRefused = (err: unknown, outgoing: StudioChatMessage[]): StudioChatMessage[] => {
    if (!(err instanceof StemCloudError) || err.code !== 'provider_unavailable' || !outgoing.some((m) => m.role === 'user' && m.audio)) return outgoing
    setListenAvailable(false)
    return withoutListen(outgoing)
  }

  /**
   * Envia la conversacion: la primera vez pide el costo y espera la confirmacion. Un mensaje con
   * fragmento para escuchar se cotiza y confirma siempre (lleva recargo).
   */
  const send = async (outgoing: StudioChatMessage[]) => {
    const cloud = controller.cloud
    if (!cloud || !canRun) return
    if (approved && !lastHasListen(outgoing)) {
      await launch(outgoing)
      return
    }
    setPhase({ kind: 'quoting' })
    try {
      const quoted = await estimateV2(cloud, controller.sessionId, buildRequest(outgoing))
      setListenAvailable(quoted.listen === true)
      setPhase({ kind: 'confirm', outgoing, estimate: quoted })
    } catch (err) {
      setPhase({ kind: 'failed', ...failureOf(err), outgoing: listenRefused(err, outgoing) })
    }
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const text = draft.trim()
    if (!text || busy || waitingDecision) return
    setDraft('')
    const attached = listen.attached
    setListen({ busy: false, attached: null, error: null })
    void send(appendUserMessage(messages, text, attached))
  }

  /** MEDIR MEZCLA: la medicion del asistente de mezcla, en este equipo; viaja en el resumen. */
  const measureMix = async () => {
    if (measure.busy) return
    setMeasure({ busy: true, note: 'MIDIENDO...' })
    try {
      const m = await controller.measureForChat({ progress: (text) => setMeasure({ busy: true, note: text }) })
      const n = m.metrics.tracks.length
      setMeasure({ busy: false, note: `MEZCLA MEDIDA (${n === 1 ? '1 PISTA' : `${n} PISTAS`}): VA EN EL PRÓXIMO MENSAJE` })
    } catch (err) {
      setMeasure({ busy: false, note: err instanceof Error && err.message ? err.message : 'No se pudo medir la mezcla.' })
    }
  }

  /** ESCUCHAR FRAGMENTO: 30 s desde el cabezal, se sube y se adjunta al proximo mensaje. */
  const prepareListen = async () => {
    if (listen.busy) return
    setListen({ busy: true, attached: null, error: null })
    try {
      const attached = await controller.prepareListenExcerpt(controller.engine.position())
      setListen({ busy: false, attached, error: null })
    } catch (err) {
      setListen({ busy: false, attached: null, error: err instanceof Error && err.message ? err.message : 'No se pudo preparar el fragmento.' })
    }
  }

  const resume = async () => {
    const cloud = controller.cloud
    if (!cloud || phase.kind !== 'pending') return
    const { jobId, outgoing } = phase
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setPhase({ kind: 'running' })
    try {
      const final = await resumeJobV2(cloud, controller.sessionId, jobId, { signal: ctrl.signal })
      if (!final || ctrl.signal.aborted) return
      receive(buildRequest(outgoing), final)
    } catch (err) {
      if (ctrl.signal.aborted) return
      if (err instanceof StemCloudError && err.code === 'no_job') {
        setPhase({ kind: 'failed', title: 'EL MENSAJE NO LLEGÓ', message: 'La nube no tiene ese mensaje: no se cobró. Puedes reenviarlo.', outgoing })
        return
      }
      setPhase({ kind: 'pending', jobId, message: `${jobErrorMessage(err)} Consúltalo de nuevo más tarde.`, outgoing })
    }
  }

  /** Cuando no queda ningun cambio por decidir, el mensaje `tool` entra a la conversacion. */
  const settleIfDone = (current: StudioChatMessage[], next: Proposal) => {
    if (!allSettled(next.pendings)) return
    setDescriptions((map) => {
      const copy: Record<string, string> = { ...map }
      for (const p of next.pendings) copy[p.callId] = p.description
      return copy
    })
    setMessages([...current, toolResultsMessage(next.calls, next.pendings)])
    setProposal(null)
  }

  const decide = async (index: number, accept: boolean) => {
    if (!proposal || !registry || applying) return
    const target = proposal.pendings[index]
    if (!target || target.status !== 'pending') return
    setApplying(true)
    try {
      const decided = accept ? await applyPendingCommand(target, registry, ASSISTANT_CTX) : rejectPendingCommand(target)
      const pendings = proposal.pendings.map((p, i) => (i === index ? decided : p))
      const next = { calls: proposal.calls, pendings }
      setProposal(next)
      settleIfDone(messages, next)
    } finally {
      setApplying(false)
    }
  }

  const decideAll = async (accept: boolean) => {
    if (!proposal || !registry || applying) return
    setApplying(true)
    try {
      const pendings: PendingAssistantCommand[] = []
      const bulk = bulkApplicable(proposal.pendings)
      // En orden: cada cambio aplicado es un paso de deshacer propio y puede depender del anterior.
      // APLICAR TODOS no toca lo que quita o borra: eso queda pendiente para decidirlo uno por uno.
      for (const [i, p] of proposal.pendings.entries()) {
        if (p.status !== 'pending') pendings.push(p)
        else if (!accept) pendings.push(rejectPendingCommand(p))
        else pendings.push(bulk[i] ? await applyPendingCommand(p, registry, ASSISTANT_CTX) : p)
      }
      const next = { calls: proposal.calls, pendings }
      setProposal(next)
      settleIfDone(messages, next)
    } finally {
      setApplying(false)
    }
  }

  const restart = () => {
    abortRef.current?.abort()
    setMessages([])
    setProposal(null)
    setDescriptions({})
    setPhase({ kind: 'idle' })
    setApproved(null)
    setSpentUsd(0)
    setListen({ busy: false, attached: null, error: null })
  }

  // Resultado de cada llamada ya respondida, para el historial.
  const results = new Map<string, { status: PendingAssistantCommand['status']; message: string }>()
  for (const m of messages) if (m.role === 'tool') for (const r of m.toolResults) results.set(r.callId, { status: r.response.status, message: r.response.message })
  const live = new Map((proposal?.pendings ?? []).map((p, index) => [p.callId, { p, index }]))

  const renderCall = (call: StudioChatToolCall) => {
    const current = live.get(call.id)
    if (current) {
      const { p, index } = current
      return (
        <li key={call.id} className="stu-chat-call" data-state={p.status} data-testid="studio-chat-call">
          <span className="stu-chat-call-text">
            <strong>{p.description}</strong>
            {p.status === 'pending' &&
              p.warnings?.map((w, k) => (
                <span key={k} className="stu-help" data-tone="warn" data-testid="studio-chat-warning">
                  {w}
                </span>
              ))}
            {p.status !== 'pending' && <span className="stu-help">{p.message}</span>}
          </span>
          {p.status === 'pending' ? (
            <span className="stu-actions">
              <button type="button" className="stu-btn" data-size="small" disabled={applying || !snap.ready || snap.recording} onClick={() => void decide(index, true)} aria-label={`Aplicar: ${p.description}`} data-testid="studio-chat-apply">
                <Check size={12} />
                APLICAR
              </button>
              <button type="button" className="stu-btn" data-size="small" data-tone="ghost" disabled={applying} onClick={() => void decide(index, false)} aria-label={`Descartar: ${p.description}`} data-testid="studio-chat-reject">
                DESCARTAR
              </button>
            </span>
          ) : (
            <span className="stu-badge" data-tone={p.status === 'applied' ? 'ok' : p.status === 'failed' ? 'warn' : undefined}>
              {STATUS_TEXT[p.status]}
            </span>
          )}
        </li>
      )
    }
    const done = results.get(call.id)
    const status = done?.status ?? 'failed'
    return (
      <li key={call.id} className="stu-chat-call" data-state={status} data-testid="studio-chat-call">
        <span className="stu-chat-call-text">
          <strong>{descriptions[call.id] ?? call.name}</strong>
          {done && <span className="stu-help">{done.message}</span>}
        </span>
        <span className="stu-badge" data-tone={status === 'applied' ? 'ok' : status === 'failed' ? 'warn' : undefined}>
          {STATUS_TEXT[status]}
        </span>
      </li>
    )
  }

  const pendingCount = proposal ? proposal.pendings.filter((p) => p.status === 'pending').length : 0
  const bulkCount = proposal ? bulkApplicable(proposal.pendings).filter(Boolean).length : 0
  const destructivePending = proposal ? proposal.pendings.some((p) => p.status === 'pending' && isDestructiveCommand(p)) : false

  return (
    <details className="stu-job" open data-testid="studio-job-chat">
      <summary>
        <span>ASISTENTE (CHAT)</span>
        <span className="stu-label">{spentUsd > 0 ? `${formatUsd(spentUsd)} EN ESTA CONVERSACIÓN` : 'Modelo de lenguaje'}</span>
      </summary>
      <div className="stu-job-body">
        <p className="stu-help">
          Pídele cambios en palabras: "baja la voz 3 dB", "agrega un bajo que siga los acordes", "marca el coro en el compás 17". Recibe un resumen de la sesión, nunca audio. Cada cambio que proponga lo apruebas tú, uno por uno.
        </p>

        {(messages.length > 0 || proposal) && (
          <ol ref={logRef} className="stu-chat-log" aria-live="polite" aria-label="Conversación con el asistente" data-testid="studio-chat-log">
            {messages.map((m, i) => {
              if (m.role === 'tool') return null
              if (m.role === 'user') {
                return (
                  <li key={i} className="stu-chat-msg" data-role="user">
                    <span className="stu-label">TÚ{m.audio ? ` · FRAGMENTO DE ${Math.round(m.audio.durationS)} S` : ''}</span>
                    <p>{m.text}</p>
                  </li>
                )
              }
              return (
                <li key={i} className="stu-chat-msg" data-role="model">
                  <span className="stu-label">
                    <Sparkles size={10} aria-hidden="true" /> ASISTENTE
                  </span>
                  {m.text && <StudioChatMarkdown text={m.text} />}
                  {m.toolCalls.length > 0 && <ul className="stu-chat-calls">{m.toolCalls.map(renderCall)}</ul>}
                </li>
              )
            })}
          </ol>
        )}

        {waitingDecision && (
          <div className="stu-actions" data-testid="studio-chat-decide">
            <span className="stu-label">{pendingCount === 1 ? '1 CAMBIO POR DECIDIR' : `${pendingCount} CAMBIOS POR DECIDIR`}</span>
            <span className="stu-bar-spacer" />
            <button type="button" className="stu-btn" data-size="small" disabled={applying || !snap.ready || snap.recording || bulkCount === 0} onClick={() => void decideAll(true)} data-testid="studio-chat-apply-all">
              <Check size={12} />
              APLICAR TODOS
            </button>
            <button type="button" className="stu-btn" data-size="small" data-tone="ghost" disabled={applying} onClick={() => void decideAll(false)}>
              DESCARTAR TODOS
            </button>
            {destructivePending && (
              <p className="stu-help" data-tone="warn" data-testid="studio-chat-destructive-note">
                Los cambios que quitan o borran (pistas, clips, notas o marcas) no entran en APLICAR TODOS: decide cada uno por separado.
              </p>
            )}
          </div>
        )}

        {phase.kind === 'quoting' && (
          <div className="stu-form-row" aria-live="polite">
            <span className="stu-label">CONSULTANDO EL COSTO...</span>
            <div className="stu-progress" data-indeterminate="true" aria-hidden="true">
              <div />
            </div>
          </div>
        )}
        {phase.kind === 'running' && (
          <div className="stu-form-row" aria-live="polite" data-testid="studio-chat-running">
            <span className="stu-label">EL ASISTENTE ESTÁ PENSANDO...</span>
            <div className="stu-progress" data-indeterminate="true" aria-hidden="true">
              <div />
            </div>
            <button
              type="button"
              className="stu-btn"
              data-tone="ghost"
              onClick={() => {
                abortRef.current?.abort()
                setPhase({ kind: 'idle' })
              }}
            >
              DEJAR DE ESPERAR
            </button>
          </div>
        )}
        {phase.kind === 'confirm' && (
          <div className="stu-confirm" role="alertdialog" aria-label="Confirmar el costo del asistente" data-testid="studio-chat-confirm">
            <p>
              <strong>{estimateText(phase.estimate)}</strong>
            </p>
            <p className="stu-help">Cada mensaje al asistente gasta créditos de la banda, aproximadamente lo mismo. Se confirma una vez por conversación; los cambios que proponga no tocan la sesión hasta que los apliques.</p>
            <div className="stu-actions" data-align="end">
              <button ref={confirmCancelRef} type="button" className="stu-btn" onClick={() => setPhase({ kind: 'idle' })} data-testid="studio-chat-cancel">
                <X size={13} />
                CANCELAR
              </button>
              <button
                type="button"
                className="stu-btn"
                data-tone="primary"
                disabled={!phase.estimate.allowed}
                title={phase.estimate.allowed ? undefined : 'Pasaría el tope mensual de la banda'}
                onClick={() => {
                  setApproved(phase.estimate)
                  void launch(phase.outgoing)
                }}
                data-testid="studio-chat-launch"
              >
                ENVIAR POR {formatUsd(phase.estimate.estimatedCostUsd)}
              </button>
            </div>
          </div>
        )}
        {phase.kind === 'pending' && (
          <div className="stu-notice" data-tone="warn" role="alert" data-testid="studio-chat-pending">
            <span>
              <strong>RESPUESTA PENDIENTE.</strong> {phase.message}
            </span>
            <div className="stu-notice-actions">
              <button type="button" className="stu-btn" data-tone="primary" onClick={() => void resume()} title="Consulta el mensaje ya enviado. No cobra de nuevo">
                <RefreshCw size={12} />
                CONSULTAR DE NUEVO
              </button>
              <button type="button" className="stu-btn" data-tone="ghost" onClick={() => setPhase({ kind: 'idle' })}>
                OLVIDAR
              </button>
            </div>
          </div>
        )}
        {phase.kind === 'failed' && (
          <div className="stu-notice" data-tone="error" role="alert" data-testid="studio-chat-failed">
            <span>
              <strong>{phase.title}.</strong> {phase.message}
            </span>
            <div className="stu-notice-actions">
              {phase.outgoing && (
                <button type="button" className="stu-btn" disabled={!canRun} onClick={() => phase.outgoing && void send(phase.outgoing)}>
                  <RefreshCw size={12} />
                  REINTENTAR
                </button>
              )}
              <button type="button" className="stu-btn" data-tone="ghost" onClick={() => setPhase({ kind: 'idle' })}>
                ENTENDIDO
              </button>
            </div>
          </div>
        )}

        <form className="stu-chat-form" onSubmit={submit}>
          <label className="stu-form-row">
            <span className="stu-param-head">
              <span className="stu-label">Mensaje · Enter envía, Shift+Enter salta de línea</span>
              <span className="stu-label">
                {draft.length}/{CHAT_MAX_USER_TEXT}
              </span>
            </span>
            <textarea
              className="stu-field stu-textarea"
              rows={3}
              value={draft}
              maxLength={CHAT_MAX_USER_TEXT}
              disabled={!canRun || busy}
              placeholder={waitingDecision ? 'Aplica o descarta los cambios propuestos antes de seguir.' : 'Qué quieres cambiar en la sesión'}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // Enter (o Ctrl+Enter) envia; Shift+Enter hace salto de linea. Mientras un metodo de
                // entrada compone (acentos, IME) Enter confirma la letra y no envia.
                if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              }}
              data-testid="studio-chat-input"
            />
          </label>
          <div className="stu-actions">
            <button type="submit" className="stu-btn" data-tone="primary" disabled={!canRun || busy || waitingDecision || draft.trim().length === 0 || !registry} data-testid="studio-chat-send">
              <Send size={13} />
              {approved ? `ENVIAR · ${formatUsd(approved.estimatedCostUsd)}` : 'ENVIAR...'}
            </button>
            {canContinue && !busy && (
              <button type="button" className="stu-btn" disabled={!canRun} onClick={() => void send(messages)} title="El asistente ve qué cambios aplicaste o descartaste y sigue" data-testid="studio-chat-continue">
                <MessageSquare size={13} />
                CONTINUAR
              </button>
            )}
            <button
              type="button"
              className="stu-btn"
              data-size="small"
              data-tone="ghost"
              disabled={measure.busy || busy || !snap.ready || snap.recording}
              onClick={() => void measureMix()}
              title="Mide volumen, pico y energía por banda de cada pista en este equipo (gratis, no sale audio). El asistente recibe esos números"
              data-testid="studio-chat-measure"
            >
              <Activity size={12} />
              {measure.busy ? 'MIDIENDO...' : 'MEDIR MEZCLA'}
            </button>
            {listenAvailable && (
              <button
                type="button"
                className="stu-btn"
                data-size="small"
                data-tone="ghost"
                disabled={listen.busy || busy || !canRun || !snap.ready || snap.recording}
                onClick={() => void prepareListen()}
                title="Adjunta al próximo mensaje 30 s de la mezcla desde el cabezal (mono, baja resolución). El envío pide confirmar el costo"
                data-testid="studio-chat-listen"
              >
                <Headphones size={12} />
                {listen.busy ? 'PREPARANDO...' : 'ESCUCHAR FRAGMENTO'}
              </button>
            )}
            <span className="stu-bar-spacer" />
            {messages.length > 0 && (
              <button type="button" className="stu-btn" data-tone="ghost" disabled={busy || applying} onClick={restart} title="Empieza una conversación nueva; los cambios aplicados se quedan en la sesión" data-testid="studio-chat-restart">
                <RotateCcw size={13} />
                NUEVA
              </button>
            )}
          </div>
          {measure.note && (
            <p className="stu-help" aria-live="polite" data-testid="studio-chat-measure-note">
              {measure.note}
            </p>
          )}
          {(listen.attached || listen.error) && (
            <p className="stu-help" data-tone={listen.error ? 'warn' : undefined} aria-live="polite" data-testid="studio-chat-listen-note">
              {listen.error ?? `FRAGMENTO DE ${Math.round(listen.attached!.durationS)} S ADJUNTO AL PRÓXIMO MENSAJE (con recargo). `}
              {listen.attached && (
                <button type="button" className="stu-btn" data-size="small" data-tone="ghost" onClick={() => setListen({ busy: false, attached: null, error: null })}>
                  QUITAR
                </button>
              )}
            </p>
          )}
        </form>
      </div>
    </details>
  )
}
