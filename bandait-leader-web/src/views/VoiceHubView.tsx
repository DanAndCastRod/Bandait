import React from 'react'
import { Info, Mic } from 'lucide-react'
import { useHub } from '../context/hubContextCore'
import type { VoiceOutput } from '../types/hub'
import { VOICE_OPTIONS } from '../services/workspaceSchema'
import { cardStyle, colors, headerBarStyle, inputStyle, labelStyle, mono, viewStyle } from '../components/hubStyles'

/** Hasta que BPM cabe cada palabra del conteo (medido con Azure F0 el 2026-10-01, WORKSPACE_V2 5.1). */
const FIT_TABLE: Record<string, { base: number; fast: number }> = {
  'es-CO-SalomeNeural': { base: 139, fast: 191 },
  'es-CO-GonzaloNeural': { base: 163, fast: 226 },
}

const RATE_STEPS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50]

function rateToNumber(rate: string): number {
  const m = rate.match(/^\+(\d{1,2})%$/)
  return m ? Math.min(50, Number(m[1])) : 0
}

const OUTPUT_TEXT: Record<VoiceOutput, string> = {
  drummer: 'Solo baterista (salida de clic)',
  all_in_ear: 'Todos los in-ear',
}

const Toggle: React.FC<{ id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }> = ({
  id,
  label,
  hint,
  checked,
  onChange,
}) => (
  <label htmlFor={id} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', cursor: 'pointer', minWidth: 0 }}>
    <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: '3px', accentColor: colors.orange }} />
    <span style={{ minWidth: 0 }}>
      <span style={{ display: 'block', fontSize: '13px', fontWeight: 700, color: colors.text }}>{label}</span>
      {hint && <span style={{ display: 'block', fontSize: '11px', color: colors.muted }}>{hint}</span>}
    </span>
  </label>
)

export const VoiceHubView: React.FC = () => {
  const { activeBand, voiceConfig, updateVoiceConfig } = useHub()
  const rateNumber = rateToNumber(voiceConfig.rate)
  const knownVoice = VOICE_OPTIONS.some((v) => v.id === voiceConfig.voice)
  const fit = FIT_TABLE[voiceConfig.voice]

  return (
    <div style={viewStyle}>
      <div style={headerBarStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Mic size={22} style={{ color: colors.cyan, flexShrink: 0 }} />
            <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 800, letterSpacing: '-0.5px' }}>Voz y Conteos</h2>
          </div>
          <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: colors.muted }}>
            Conteo hablado y avisos de sección para {activeBand?.name}. Lo ejecuta el líder durante el show.
          </p>
        </div>
      </div>

      <div
        data-testid="voice-note"
        style={{
          ...cardStyle,
          background: colors.oled,
          borderColor: colors.cobalt,
          padding: '12px 14px',
          display: 'flex',
          gap: '10px',
          fontSize: '12px',
          color: colors.muted,
          lineHeight: 1.5,
        }}
      >
        <Info size={16} style={{ color: colors.cobalt, flexShrink: 0, marginTop: '2px' }} />
        <div>
          El audio de la voz se genera <strong style={{ color: colors.text }}>antes del show</strong>, una palabra por beat, y el líder lo
          reproduce sin red en el escenario. La vista previa de la voz llega en una versión posterior: por ahora aquí solo se guarda la
          configuración de la banda.
        </div>
      </div>

      <div style={{ ...cardStyle, padding: '14px', display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '760px', minWidth: 0 }}>
        <Toggle
          id="voice-enabled"
          label="Activar voz en el show"
          hint="Si está apagada, el líder solo usa el clic."
          checked={voiceConfig.enabled}
          onChange={(v) => updateVoiceConfig({ enabled: v })}
        />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px', opacity: voiceConfig.enabled ? 1 : 0.55 }}>
          <div>
            <label htmlFor="voice-voice" style={labelStyle}>
              VOZ (AZURE, ES-CO)
            </label>
            <select id="voice-voice" value={voiceConfig.voice} onChange={(e) => updateVoiceConfig({ voice: e.target.value })} style={inputStyle}>
              {VOICE_OPTIONS.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
              {!knownVoice && <option value={voiceConfig.voice}>{voiceConfig.voice}</option>}
            </select>
          </div>
          <div>
            <label htmlFor="voice-rate" style={labelStyle}>
              VELOCIDAD: <span style={{ color: colors.text }}>+{rateNumber}%</span>
            </label>
            <select id="voice-rate" value={rateNumber} onChange={(e) => updateVoiceConfig({ rate: `+${e.target.value}%` })} style={inputStyle}>
              {RATE_STEPS.map((n) => (
                <option key={n} value={n}>
                  +{n}%
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="voice-lead" style={labelStyle}>
              AVISO ANTES DE CADA SECCIÓN
            </label>
            <select
              id="voice-lead"
              value={voiceConfig.cueLeadBars}
              onChange={(e) => updateVoiceConfig({ cueLeadBars: e.target.value === '2' ? 2 : 1 })}
              style={inputStyle}
            >
              <option value={1}>1 compás antes</option>
              <option value={2}>2 compases antes</option>
            </select>
          </div>
          <div>
            <label htmlFor="voice-output" style={labelStyle}>
              SALIDA DEL LÍDER
            </label>
            <select
              id="voice-output"
              value={voiceConfig.output}
              onChange={(e) => updateVoiceConfig({ output: e.target.value as VoiceOutput })}
              style={inputStyle}
            >
              <option value="drummer">{OUTPUT_TEXT.drummer}</option>
              <option value="all_in_ear">{OUTPUT_TEXT.all_in_ear}</option>
            </select>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px' }}>
          <Toggle
            id="voice-countin"
            label="Decir los números del conteo"
            hint='"Uno, dos, tres, cuatro" en los compases de conteo de cada tema.'
            checked={voiceConfig.countIn}
            onChange={(v) => updateVoiceConfig({ countIn: v })}
          />
          <Toggle
            id="voice-cues"
            label="Avisar cada sección"
            hint='"Coro", "Puente"... según el tipo o el aviso de cada sección.'
            checked={voiceConfig.sectionCues}
            onChange={(v) => updateVoiceConfig({ sectionCues: v })}
          />
        </div>

        {fit && (
          <div data-testid="voice-fit" style={{ fontFamily: mono, fontSize: '11px', color: colors.muted, lineHeight: 1.6 }}>
            A +0% cada número cabe hasta ~{fit.base} BPM; a +35% hasta ~{fit.fast} BPM. Si no cabe, el líder usa la variante rápida
            y, si tampoco, cuenta solo los beats impares y deja el clic en los pares.
          </div>
        )}
      </div>
    </div>
  )
}
