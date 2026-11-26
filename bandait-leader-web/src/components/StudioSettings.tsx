import React, { useEffect, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { cardStyle, colors, headerBarStyle, mono, viewStyle } from './hubStyles'
import {
  readStudioPrefs,
  STUDIO_PREFS_EVENT,
  writeStudioPrefs,
  type RecordingOnLeave,
  type StudioPrefs,
} from '../services/studio/studioPrefs'
import '../styles/waveform.css'

const sectionTitle: React.CSSProperties = {
  margin: 0,
  fontFamily: mono,
  fontSize: '11px',
  fontWeight: 700,
  letterSpacing: '1px',
  color: colors.muted,
}

const sectionStyle: React.CSSProperties = {
  ...cardStyle,
  padding: '14px',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  minWidth: 0,
  maxWidth: '640px',
}

const OPTIONS: ReadonlyArray<{ id: RecordingOnLeave; label: string; hint: string }> = [
  {
    id: 'continue',
    label: 'Seguir grabando',
    hint: 'La toma continúa en segundo plano mientras usas otras vistas; al volver al Estudio la encuentras grabando.',
  },
  {
    id: 'stop',
    label: 'Detener la toma',
    hint: 'Al salir del Estudio la toma se detiene y lo grabado queda como clip en la pista, igual que al pulsar REC.',
  },
]

/**
 * AJUSTES > ESTUDIO: preferencias del Estudio que son de este equipo (localStorage). Por ahora,
 * que hace una toma en curso al salir de la vista del Estudio; por defecto sigue grabando.
 */
export const StudioSettings: React.FC = () => {
  const [prefs, setPrefs] = useState<StudioPrefs>(readStudioPrefs)

  // Otra pestana o el propio Estudio pueden cambiarla: se relee con el aviso y con `storage`.
  useEffect(() => {
    const reload = () => setPrefs(readStudioPrefs())
    window.addEventListener(STUDIO_PREFS_EVENT, reload)
    window.addEventListener('storage', reload)
    return () => {
      window.removeEventListener(STUDIO_PREFS_EVENT, reload)
      window.removeEventListener('storage', reload)
    }
  }, [])

  const current = OPTIONS.find((option) => option.id === prefs.recordingOnLeave) ?? OPTIONS[0]

  return (
    <div style={viewStyle} data-testid="studio-settings">
      <div style={headerBarStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <SlidersHorizontal size={22} style={{ color: colors.orange, flexShrink: 0 }} aria-hidden />
            <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 800, letterSpacing: '-0.5px' }}>Estudio</h2>
          </div>
          <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: colors.muted }}>
            Comportamiento del Estudio en este equipo. Se guarda en este navegador.
          </p>
        </div>
      </div>

      <section style={sectionStyle} aria-labelledby="studio-settings-leave-title">
        <h3 id="studio-settings-leave-title" style={sectionTitle}>
          GRABACIÓN AL SALIR DEL ESTUDIO
        </h3>
        <div className="wf-seg" role="radiogroup" aria-labelledby="studio-settings-leave-title" data-testid="studio-settings-on-leave">
          {OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={prefs.recordingOnLeave === option.id}
              className="wf-seg-btn"
              onClick={() => setPrefs(writeStudioPrefs({ recordingOnLeave: option.id }))}
              data-testid={`studio-settings-on-leave-${option.id}`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p style={{ margin: 0, fontSize: '13px', color: colors.muted, lineHeight: 1.5 }} data-testid="studio-settings-on-leave-hint">
          {current.hint}
        </p>
      </section>
    </div>
  )
}
