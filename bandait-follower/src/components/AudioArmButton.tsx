import { useEffect, useState } from 'react'
import { AudioState } from '../services/flywheelClock'
import { VolumeIcon } from './Icons'

interface Props {
  audio: AudioState
  localMuted: boolean
  /** Must call flywheelClock.armAudio() synchronously (user gesture). */
  onArm: () => void
}

/** Second tap must land within this window to release SILENCIO LOCAL. */
export const CONFIRM_WINDOW_MS = 3000

/**
 * Explicit "ACTIVAR AUDIO" control. iOS only plays Web Audio after a user
 * gesture, so it stays visible until the AudioContext is running.
 * While SILENCIO LOCAL is active (emergency slide or mixer cut), releasing it
 * takes a deliberate double confirmation so a stray touch cannot bring the
 * in-ear back by accident.
 */
export default function AudioArmButton({ audio, localMuted, onArm }: Props) {
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!confirming) return
    const t = setTimeout(() => setConfirming(false), CONFIRM_WINDOW_MS)
    return () => clearTimeout(t)
  }, [confirming])

  useEffect(() => {
    if (!localMuted) setConfirming(false)
  }, [localMuted])

  if (audio === 'armed' && !localMuted) return null

  if (audio === 'unsupported') {
    return (
      <div className="audio-arm-banner unsupported" role="status">
        <VolumeIcon size={16} />
        <span>AUDIO NO DISPONIBLE EN ESTE NAVEGADOR // SOLO METRONOMO VISUAL</span>
      </div>
    )
  }

  if (localMuted) {
    const handleMutedTap = () => {
      if (!confirming) {
        setConfirming(true)
        return
      }
      setConfirming(false)
      onArm() // second tap: still inside the gesture, as iOS requires
    }
    return (
      <button
        type="button"
        role="alert"
        className={`audio-arm-banner muted ${confirming ? 'confirming' : ''}`}
        onClick={handleMutedTap}
      >
        <VolumeIcon size={16} />
        <span>
          {confirming
            ? 'TOCA OTRA VEZ PARA QUITAR EL SILENCIO LOCAL'
            : 'SILENCIO LOCAL ACTIVO // CLIC E IN-EAR MUDOS // TOCA PARA REACTIVAR'}
        </span>
      </button>
    )
  }

  const label =
    audio === 'suspended' ? 'AUDIO EN PAUSA POR EL SISTEMA // TOCA PARA REACTIVAR' : 'ACTIVAR AUDIO // CLIC E IN-EAR'

  return (
    <button type="button" className="audio-arm-banner" onClick={onArm}>
      <VolumeIcon size={16} />
      <span>{label}</span>
    </button>
  )
}
