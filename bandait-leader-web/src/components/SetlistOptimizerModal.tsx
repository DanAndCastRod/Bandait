import React, { useMemo, useState } from 'react'
import { Activity, Check, Lock, Pin, Sparkles, Unlock } from 'lucide-react'
import { useHub } from '../context/hubContextCore'
import {
  optimizeSetlistOrder,
  SETLIST_OPTIMIZER_PROFILES,
  type SetlistEnergyProfile,
} from '../services/setlistOptimizer'
import type { Playlist } from '../types/hub'
import { HubModal } from './HubModal'
import { cardStyle, colors, ghostButton, labelStyle, mono, primaryButton, radius } from './hubStyles'

interface Props {
  playlist: Playlist
  onClose: () => void
}

const PROFILE_LIST: readonly SetlistEnergyProfile[] = ['standard_show', 'in_crescendo', 'continuous_camelot', 'smooth_bpm']

function polylinePoints(values: readonly number[], width: number, height: number, pad = 10): string {
  if (values.length === 0) return ''
  if (values.length === 1) return `${width / 2},${height - pad - values[0] * (height - pad * 2)}`
  return values
    .map((v, idx) => {
      const x = pad + (idx / (values.length - 1)) * (width - pad * 2)
      const y = height - pad - Math.max(0, Math.min(1, v)) * (height - pad * 2)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

/**
 * Optimizador Combinatorio de Setlists (Investigacion de Operaciones: Simulated Annealing + 2-opt):
 *   - Minimiza saltos armonicos Camelot, saltos bruscos de BPM y fatiga vocal consecutiva
 *   - Sigue la curva dramatica elegida respetando canciones ancladas (ej. apertura y cierre)
 *   - Incluye interruptor de divulgacion progresiva `LAB` con curva SVG de energia y desglose de costos
 *   - Guarda un snapshot VCS automatico antes de aplicar para revertir en 1 clic
 */
export const SetlistOptimizerModal: React.FC<Props> = ({ playlist, onClose }) => {
  const { sharing, commitPlaylistVersion, replaceActivePlaylistSongs } = useHub()
  const [profile, setProfile] = useState<SetlistEnergyProfile>('standard_show')
  const [pinned, setPinned] = useState<ReadonlySet<number>>(() => new Set())
  const [labOpen, setLabOpen] = useState(false)

  const togglePin = (index: number) => {
    setPinned((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const result = useMemo(
    () =>
      optimizeSetlistOrder(playlist.songs, {
        profile,
        pinnedIndices: pinned,
        iterations: 1200,
      }),
    [playlist.songs, profile, pinned],
  )

  const orderChanged = useMemo(() => result.order.some((origIdx, idx) => origIdx !== idx), [result.order])

  const handleApply = () => {
    if (!sharing.activeCanEdit || !orderChanged) return
    commitPlaylistVersion(playlist.id, `Antes de optimizar (${SETLIST_OPTIMIZER_PROFILES[profile].label})`)
    replaceActivePlaylistSongs(result.songs)
    onClose()
  }

  return (
    <HubModal title="OPTIMIZADOR DE SETLIST (IA / IO)" onClose={onClose} maxWidth="640px" testId="setlist-optimizer-modal">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', fontSize: '13px' }}>
        {/* Selector de perfil dramatico + LAB toggle */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={labelStyle}>CURVA DRAMÁTICA Y OBJETIVO DE FLUJO</span>
          <button
            type="button"
            onClick={() => setLabOpen((v) => !v)}
            style={{
              ...ghostButton,
              padding: '4px 10px',
              fontSize: '11px',
              borderRadius: radius.control,
              border: labOpen ? '1px solid var(--b-accent)' : '1px solid var(--b-border)',
              color: labOpen ? 'var(--b-accent)' : colors.muted,
            }}
            data-testid="setlist-optimizer-lab-toggle"
          >
            <Activity size={12} /> LAB {labOpen ? 'ACTIVO' : 'VER CURVAS'}
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '6px' }}>
          {PROFILE_LIST.map((id) => {
            const spec = SETLIST_OPTIMIZER_PROFILES[id]
            const active = profile === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => setProfile(id)}
                data-testid={`setlist-profile-${id}`}
                style={{
                  ...ghostButton,
                  justifyContent: 'flex-start',
                  textAlign: 'left',
                  padding: '8px 10px',
                  fontSize: '11px',
                  borderRadius: radius.control,
                  background: active ? 'var(--b-accent)' : 'var(--b-elevated)',
                  color: active ? 'var(--b-on-accent)' : colors.text,
                  fontWeight: active ? 700 : 600,
                }}
              >
                {spec.label}
              </button>
            )
          })}
        </div>
        <div style={{ fontSize: '12px', color: colors.muted }}>{SETLIST_OPTIMIZER_PROFILES[profile].description}</div>

        {/* Resumen matematico y grafica LAB */}
        <div
          style={{
            ...cardStyle,
            padding: '10px 12px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '8px',
          }}
        >
          <span style={{ fontFamily: mono, fontSize: '12px', color: colors.text }}>
            Mejora de función objetivo:{' '}
            <strong style={{ color: result.improvementPct > 0 ? colors.success : colors.muted }}>
              {result.improvementPct > 0 ? `-${result.improvementPct}% fricción` : 'Orden actual ya es óptimo'}
            </strong>
          </span>
          <span style={{ fontFamily: mono, fontSize: '11px', color: colors.muted }}>
            Anclas fijas: {pinned.size} · Temas: {playlist.songs.length}
          </span>
        </div>

        {labOpen && (
          <div
            data-testid="setlist-optimizer-lab-panel"
            style={{
              ...cardStyle,
              padding: '12px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              background: 'var(--b-well)',
            }}
          >
            <span style={labelStyle}>SIMULATED ANNEALING + 2-OPT · TELEMETRÍA</span>
            <svg viewBox="0 0 360 110" style={{ width: '100%', height: '110px', display: 'block' }} aria-label="Curva de energía del show">
              <polyline
                fill="none"
                stroke="var(--b-muted)"
                strokeWidth="1.5"
                strokeDasharray="4 3"
                points={polylinePoints(result.targetCurve, 360, 110)}
              />
              <polyline
                fill="none"
                stroke="var(--b-cobalt)"
                strokeWidth="1.5"
                opacity="0.55"
                points={polylinePoints(result.energyBefore, 360, 110)}
              />
              <polyline
                fill="none"
                stroke="var(--b-accent)"
                strokeWidth="2.4"
                points={polylinePoints(result.energyAfter, 360, 110)}
              />
            </svg>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '6px', fontFamily: mono, fontSize: '11px' }}>
              <span>Camelot: {result.before.camelotCost.toFixed(2)} -&gt; {result.after.camelotCost.toFixed(2)}</span>
              <span>Delta BPM: {result.before.bpmCost.toFixed(2)} -&gt; {result.after.bpmCost.toFixed(2)}</span>
              <span>Error Arco: {result.before.arcCost.toFixed(2)} -&gt; {result.after.arcCost.toFixed(2)}</span>
              <span>Fatiga Vocal: {result.before.fatigueCost.toFixed(2)} -&gt; {result.after.fatigueCost.toFixed(2)}</span>
            </div>
          </div>
        )}

        {/* Lista propuesta con opcion de fijar posicion original */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '280px', overflowY: 'auto' }}>
          <span style={labelStyle}>ORDEN PROPUESTO (FIJA TEMAS QUE NO DEBAN MOVERSE)</span>
          {result.songs.map((song, newIdx) => {
            const origIdx = result.order[newIdx]
            const isPinned = pinned.has(origIdx)
            const moved = origIdx !== newIdx
            return (
              <div
                key={song.id}
                style={{
                  ...cardStyle,
                  padding: '8px 10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  border: isPinned ? '1px solid var(--b-warning)' : '1px solid var(--b-border-soft)',
                }}
              >
                <span style={{ fontFamily: mono, fontSize: '12px', fontWeight: 700, width: '24px', color: colors.muted }}>
                  {newIdx + 1}.
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {song.title}
                  </div>
                  <div style={{ fontFamily: mono, fontSize: '11px', color: colors.muted, display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <span>{song.bpm} BPM</span>
                    {song.key && <span style={{ color: colors.cobalt }}>{song.key}</span>}
                    {song.camelot && <span>{song.camelot}</span>}
                    {moved && <span style={{ color: colors.success }}>desde #{origIdx + 1}</span>}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => togglePin(origIdx)}
                  title={isPinned ? 'Liberar posición' : `Fijar en su posición original (#${origIdx + 1})`}
                  style={{
                    ...ghostButton,
                    padding: '4px 8px',
                    fontSize: '11px',
                    borderRadius: radius.control,
                    color: isPinned ? colors.warning : colors.muted,
                  }}
                >
                  {isPinned ? <Lock size={12} /> : <Unlock size={12} />}
                  {isPinned ? `FIJA #${origIdx + 1}` : 'LIBRE'}
                </button>
              </div>
            )
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' }}>
          <button type="button" onClick={onClose} style={ghostButton}>
            CANCELAR
          </button>
          <button
            type="button"
            disabled={!sharing.activeCanEdit || !orderChanged}
            onClick={handleApply}
            style={primaryButton()}
            data-testid="setlist-optimizer-apply"
          >
            <Sparkles size={13} />
            <Check size={13} />
            APLICAR ORDEN Y GUARDAR SNAPSHOT
          </button>
        </div>
        {!sharing.activeCanEdit && (
          <div style={{ fontSize: '11px', color: colors.muted }}>
            <Pin size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Solo Owner o Director Musical pueden reordenar un setlist compartido.
          </div>
        )}
      </div>
    </HubModal>
  )
}
