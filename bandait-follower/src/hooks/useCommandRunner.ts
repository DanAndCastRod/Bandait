import { useCallback, useEffect, useRef, useState } from 'react'
import { CommandAck, CommandPayloadMap, CommandRejectReason, CommandType } from '../types/protocol'
import { CommandError, CommandFailureReason } from '../services/syncService'

export type FeedbackPhase = 'pending' | 'accepted' | 'rejected' | 'failed'

export interface CommandFeedback {
  id: number
  type: CommandType
  phase: FeedbackPhase
  text: string
}

const RESULT_VISIBLE_MS = 5000

export const COMMAND_LABEL: Record<CommandType, string> = {
  PLAY: 'PLAY',
  STOP: 'STOP',
  PAUSE: 'PAUSA',
  RESUME: 'REANUDAR',
  CUE_NEXT: 'SIGUIENTE',
  CUE_PREV: 'ANTERIOR',
  JUMP_SONG: 'SALTO DE CANCION',
  TEMPO_NUDGE: 'AJUSTE DE TEMPO',
  PANIC: 'PANIC',
}

const REJECT_LABEL: Record<CommandRejectReason, string> = {
  invalid_type: 'TIPO DE COMANDO INVALIDO',
  conflict: 'CONFLICTO: OTRO EQUIPO YA MOVIO EL SETLIST',
  no_setlist: 'EL LIDER NO TIENE SETLIST CARGADO',
  out_of_range: 'FUERA DE RANGO',
}

const FAILURE_LABEL: Record<CommandFailureReason, string> = {
  offline: 'SIN CONEXION: NO SE ENVIO',
  timeout: 'SIN RESPUESTA DEL LIDER (TRAS REINTENTO)',
  connection_lost: 'CONEXION PERDIDA ANTES DE CONFIRMAR: REVISA EL ESTADO',
  invalid_ack: 'RESPUESTA INVALIDA DEL LIDER',
  invalid_payload: 'COMANDO INVALIDO',
}

export function describeAck(type: CommandType, ack: CommandAck): { phase: FeedbackPhase; text: string } {
  const label = COMMAND_LABEL[type]
  if (ack.accepted) {
    const dup = ack.duplicate ? ' [DUPLICADO, YA APLICADO]' : ''
    return { phase: 'accepted', text: `${label} ACEPTADO (${ack.actionTaken})${dup}` }
  }
  const reason = ack.reason ? REJECT_LABEL[ack.reason] : 'SIN MOTIVO'
  return { phase: 'rejected', text: `${label} RECHAZADO: ${reason}` }
}

export function describeFailure(type: CommandType, err: unknown): { phase: FeedbackPhase; text: string } {
  const label = COMMAND_LABEL[type]
  if (err instanceof CommandError) return { phase: 'failed', text: `${label}: ${FAILURE_LABEL[err.reason]}` }
  return { phase: 'failed', text: `${label}: ERROR INESPERADO` }
}

export type CommandRun = <T extends CommandType>(
  type: T,
  payload?: CommandPayloadMap[T],
) => void

/**
 * Runs a command and keeps the visible feedback (pending, accepted, rejected
 * with reason, or failed). Only the latest command is displayed.
 */
export function useCommandRunner(
  send: <T extends CommandType>(type: T, payload?: CommandPayloadMap[T]) => Promise<CommandAck>,
): { feedback: CommandFeedback | null; run: CommandRun; pending: boolean } {
  const [feedback, setFeedback] = useState<CommandFeedback | null>(null)
  const seq = useRef(0)
  const mounted = useRef(false)
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (clearTimer.current) clearTimeout(clearTimer.current)
    }
  }, [])

  const run = useCallback<CommandRun>(
    (type, payload) => {
      const id = ++seq.current
      if (clearTimer.current) clearTimeout(clearTimer.current)
      setFeedback({ id, type, phase: 'pending', text: `${COMMAND_LABEL[type]}: ENVIANDO...` })
      const finish = (result: { phase: FeedbackPhase; text: string }) => {
        if (!mounted.current || seq.current !== id) return
        setFeedback({ id, type, ...result })
        clearTimer.current = setTimeout(() => {
          if (mounted.current && seq.current === id) setFeedback(null)
        }, RESULT_VISIBLE_MS)
      }
      let promise: Promise<CommandAck>
      try {
        promise = send(type, payload)
      } catch (err) {
        finish(describeFailure(type, err))
        return
      }
      promise.then(
        (ack) => finish(describeAck(type, ack)),
        (err: unknown) => finish(describeFailure(type, err)),
      )
    },
    [send],
  )

  return { feedback, run, pending: feedback?.phase === 'pending' }
}
