import { useState, useEffect, useCallback } from 'react'
import { stemCacheService, StemType } from '../services/stemCacheService'
import { CloseIcon, ShieldIcon, PanicIcon, DownloadIcon } from './Icons'

export interface ChannelMix {
  id: StemType
  label: string
  code: string
  volume: number // 0.0 to 1.0 (default 0.8 = 0 dB)
  pan: number // -1.0 (L) to +1.0 (R)
  muted: boolean
  solo: boolean
}

interface Props {
  songId?: string
  isOpen: boolean
  onClose: () => void
  onMasterVolumeChange?: (vol: number) => void
  initialMasterVolume?: number
}

const INITIAL_CHANNELS: ChannelMix[] = [
  { id: 'drums', label: 'BATERÍA', code: '[DRM]', volume: 0.8, pan: 0, muted: false, solo: false },
  { id: 'bass', label: 'BAJO', code: '[BAS]', volume: 0.8, pan: 0, muted: false, solo: false },
  { id: 'vocals', label: 'VOCES', code: '[VOX]', volume: 0.8, pan: 0, muted: false, solo: false },
  { id: 'other', label: 'ARMONÍA', code: '[OTH]', volume: 0.8, pan: 0, muted: false, solo: false },
  { id: 'click', label: 'CLICK CLOCK', code: '[CLK]', volume: 0.75, pan: 0, muted: false, solo: false },
  { id: 'prompts', label: 'GUÍA VOZ CUES', code: '[VOZ]', volume: 0.85, pan: 0, muted: false, solo: false },
]

export default function MultiTrackMixer({
  songId = 'song_01',
  isOpen,
  onClose,
  onMasterVolumeChange,
  initialMasterVolume = 0.8,
}: Props) {
  const [channels, setChannels] = useState<ChannelMix[]>(INITIAL_CHANNELS)
  const [masterVolume, setMasterVolume] = useState<number>(initialMasterVolume)
  const [panicMuted, setPanicMuted] = useState(false)
  const [isPreloading, setIsPreloading] = useState(false)
  const [preloadProgress, setPreloadProgress] = useState<number>(0)
  const [cacheStatus, setCacheStatus] = useState<string>('COMPROBANDO...')
  const [activePreset, setActivePreset] = useState<string>('EQUILIBRADO')

  const checkCache = useCallback(async () => {
    try {
      const res = await stemCacheService.isSongFullyCached(songId)
      if (res.cached) {
        setCacheStatus(`LISTO (${res.availableStems.length}/4 STEMS EN CACHÉ)`)
      } else {
        setCacheStatus(`PARCIAL (${res.availableStems.length}/4 STEMS)`)
      }
    } catch {
      setCacheStatus('DISPONIBLE LOCAL')
    }
  }, [songId])

  useEffect(() => {
    if (isOpen) {
      checkCache()
    }
  }, [isOpen, checkCache])

  const handlePreload = async () => {
    setIsPreloading(true)
    setPreloadProgress(10)
    try {
      await stemCacheService.prefetchSongStems(songId, undefined, (p) => {
        setPreloadProgress(p.progressPercent)
      })
      await checkCache()
    } finally {
      setIsPreloading(false)
    }
  }

  const handleVolumeChange = (id: StemType, val: number) => {
    setChannels((prev) =>
      prev.map((ch) => (ch.id === id ? { ...ch, volume: Math.max(0, Math.min(1.0, val)) } : ch))
    )
  }

  const handlePanChange = (id: StemType, val: number) => {
    setChannels((prev) =>
      prev.map((ch) => (ch.id === id ? { ...ch, pan: Math.max(-1.0, Math.min(1.0, val)) } : ch))
    )
  }

  const handleToggleMute = (id: StemType) => {
    setChannels((prev) =>
      prev.map((ch) => (ch.id === id ? { ...ch, muted: !ch.muted } : ch))
    )
  }

  const handleToggleSolo = (id: StemType) => {
    setChannels((prev) =>
      prev.map((ch) => (ch.id === id ? { ...ch, solo: !ch.solo } : ch))
    )
  }

  const applyPreset = (preset: 'EQUILIBRADO' | 'BATERISTA' | 'CANTANTE' | 'ARMONÍA') => {
    setActivePreset(preset)
    setChannels((prev) => {
      switch (preset) {
        case 'BATERISTA':
          return prev.map((ch) => {
            if (ch.id === 'click') return { ...ch, volume: 1.0, muted: false }
            if (ch.id === 'bass') return { ...ch, volume: 0.9, muted: false }
            if (ch.id === 'drums') return { ...ch, volume: 0.85, muted: false }
            if (ch.id === 'prompts') return { ...ch, volume: 0.9, muted: false }
            return { ...ch, volume: 0.5, muted: false }
          })
        case 'CANTANTE':
          return prev.map((ch) => {
            if (ch.id === 'vocals') return { ...ch, volume: 1.0, muted: false }
            if (ch.id === 'prompts') return { ...ch, volume: 0.95, muted: false }
            if (ch.id === 'other') return { ...ch, volume: 0.7, muted: false }
            return { ...ch, volume: 0.5, muted: false }
          })
        case 'ARMONÍA':
          return prev.map((ch) => {
            if (ch.id === 'other') return { ...ch, volume: 0.95, muted: false }
            if (ch.id === 'vocals') return { ...ch, volume: 0.8, muted: false }
            if (ch.id === 'bass') return { ...ch, volume: 0.75, muted: false }
            return { ...ch, volume: 0.6, muted: false }
          })
        case 'EQUILIBRADO':
        default:
          return INITIAL_CHANNELS
      }
    })
  }

  const handleMasterChange = (val: number) => {
    const clamped = Math.max(0, Math.min(1.0, val))
    setMasterVolume(clamped)
    if (onMasterVolumeChange) {
      onMasterVolumeChange(clamped)
    }
  }

  const formatDb = (volume: number): string => {
    if (volume <= 0.001) return '-INF dB'
    const ratio = volume / 0.8
    const db = 20 * Math.log10(ratio)
    return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`
  }

  const hasAnySolo = channels.some((c) => c.solo)

  if (!isOpen) return null

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(5, 7, 10, 0.96)',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        backdropFilter: 'blur(10px)',
        padding: '16px 20px',
        boxSizing: 'border-box',
        overflowY: 'auto',
      }}
    >
      {/* HEADER SECTION */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: '1px solid var(--theme-border)',
          paddingBottom: '12px',
          marginBottom: '14px',
          flexWrap: 'wrap',
          gap: '12px',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '11px',
                background: 'var(--accent-active)',
                color: 'var(--bg-primary)',
                padding: '3px 8px',
                borderRadius: 'var(--theme-radius)',
                letterSpacing: '1px',
                fontWeight: 800,
              }}
            >
              [DSP RETORNO IN-EAR]
            </span>
            <h2
              style={{
                margin: 0,
                fontFamily: 'var(--font-mono)',
                fontSize: '17px',
                fontWeight: 800,
                textTransform: 'uppercase',
                letterSpacing: '1px',
                color: 'var(--text-primary)',
              }}
            >
              CONSOLA DE MONITOREO PERSONAL
            </h2>
          </div>
          <p
            style={{
              margin: '4px 0 0 0',
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              color: 'var(--text-secondary)',
            }}
          >
            Aislamiento estéreo multicanal con techo acústico calibrado a -0.5 dBFS.
          </p>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="btn-stage btn-stage-secondary"
          style={{ padding: '8px 16px', fontSize: '12px' }}
        >
          <CloseIcon size={14} />
          <span>CERRAR</span>
        </button>
      </div>

      {/* TOP STATUS & PRESETS BAR */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '12px',
          marginBottom: '14px',
          background: 'var(--bg-surface)',
          border: '1px solid var(--theme-border)',
          borderRadius: 'var(--theme-radius)',
          padding: '10px 14px',
        }}
      >
        {/* PRESET BUTTONS */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              color: 'var(--text-secondary)',
              letterSpacing: '1px',
              fontWeight: 700,
            }}
          >
            PRESETS:
          </span>
          {(['EQUILIBRADO', 'BATERISTA', 'CANTANTE', 'ARMONÍA'] as const).map((preset) => {
            const isActive = activePreset === preset
            return (
              <button
                key={preset}
                type="button"
                onClick={() => applyPreset(preset)}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '11px',
                  fontWeight: 700,
                  padding: '5px 12px',
                  borderRadius: 'var(--theme-radius)',
                  cursor: 'pointer',
                  background: isActive ? 'var(--accent-active)' : 'var(--bg-elevated)',
                  color: isActive ? 'var(--bg-primary)' : 'var(--text-secondary)',
                  border: isActive ? '1px solid var(--accent-active)' : '1px solid var(--theme-border)',
                  letterSpacing: '0.5px',
                  transition: 'all 0.15s ease',
                }}
              >
                [{preset}]
              </button>
            )
          })}
        </div>

        {/* STEM CACHE STATUS & PRELOAD BUTTON */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              color: 'var(--accent-success)',
              border: '1px solid var(--accent-success)',
              background: 'rgba(16, 185, 129, 0.1)',
              padding: '4px 10px',
              borderRadius: 'var(--theme-radius)',
            }}
          >
            {cacheStatus}
          </span>

          <button
            type="button"
            onClick={handlePreload}
            disabled={isPreloading}
            className="btn-stage btn-stage-secondary"
            style={{ padding: '6px 12px', fontSize: '11px' }}
          >
            <DownloadIcon size={13} />
            <span>{isPreloading ? `DESCARGANDO ${preloadProgress}%` : 'PRE-CARGAR'}</span>
          </button>
        </div>
      </div>

      {/* CHANNEL STRIPS GRID */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
          gap: '10px',
          flex: 1,
          alignItems: 'stretch',
          marginBottom: '16px',
        }}
      >
        {channels.map((ch) => {
          const isAudible = hasAnySolo ? ch.solo : !ch.muted && !panicMuted
          const isNearLimiter = ch.volume > 0.92

          return (
            <div
              key={ch.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                background: 'var(--theme-card-bg)',
                border: ch.solo
                  ? '1px solid var(--accent-warning)'
                  : ch.muted
                  ? '1px solid var(--text-disabled)'
                  : '1px solid var(--theme-border)',
                borderRadius: 'var(--theme-radius)',
                padding: '14px 10px',
                opacity: isAudible ? 1 : 0.45,
                transition: 'border-color 0.15s, opacity 0.15s',
              }}
            >
              {/* Channel Code & Name */}
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '13px',
                  fontWeight: 800,
                  letterSpacing: '1px',
                  color: isAudible ? 'var(--text-primary)' : 'var(--text-disabled)',
                  marginBottom: '2px',
                }}
              >
                {ch.code}
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '9px',
                  color: 'var(--text-secondary)',
                  letterSpacing: '0.5px',
                  marginBottom: '10px',
                  textTransform: 'uppercase',
                }}
              >
                {ch.label}
              </div>

              {/* Volume dB Readout */}
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '12px',
                  color: isNearLimiter ? 'var(--accent-danger)' : 'var(--accent-active)',
                  fontWeight: 700,
                  marginBottom: '8px',
                }}
              >
                {formatDb(ch.volume)}
              </div>

              {/* Vertical Fader Simulation */}
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  minHeight: '140px',
                  justifyContent: 'center',
                  width: '100%',
                }}
              >
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={ch.volume}
                  onChange={(e) => handleVolumeChange(ch.id, parseFloat(e.target.value))}
                  style={{
                    writingMode: 'vertical-lr',
                    direction: 'rtl',
                    height: '130px',
                    width: '32px',
                    cursor: 'pointer',
                    accentColor: isNearLimiter ? 'var(--accent-danger)' : 'var(--accent-active)',
                  }}
                />
              </div>

              {/* Safety Limiter Dot */}
              <div
                style={{
                  marginTop: '8px',
                  marginBottom: '10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                }}
              >
                <span
                  style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    backgroundColor: isNearLimiter ? 'var(--accent-danger)' : 'var(--theme-border)',
                  }}
                />
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '9px',
                    color: isNearLimiter ? 'var(--accent-danger)' : 'var(--text-disabled)',
                  }}
                >
                  -0.5dB
                </span>
              </div>

              {/* Pan Slider */}
              <div style={{ width: '100%', padding: '0 4px', marginBottom: '10px' }}>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '9px',
                    color: 'var(--text-secondary)',
                    display: 'flex',
                    justifyContent: 'space-between',
                  }}
                >
                  <span>L</span>
                  <span>
                    {ch.pan === 0 ? 'C' : ch.pan > 0 ? `R${Math.round(ch.pan * 100)}` : `L${Math.round(Math.abs(ch.pan) * 100)}`}
                  </span>
                  <span>R</span>
                </div>
                <input
                  type="range"
                  min="-1"
                  max="1"
                  step="0.05"
                  value={ch.pan}
                  onChange={(e) => handlePanChange(ch.id, parseFloat(e.target.value))}
                  style={{ width: '100%', height: '4px', cursor: 'pointer', accentColor: 'var(--text-secondary)' }}
                />
              </div>

              {/* Solo & Mute Buttons */}
              <div style={{ display: 'flex', gap: '6px', width: '100%' }}>
                <button
                  type="button"
                  onClick={() => handleToggleSolo(ch.id)}
                  style={{
                    flex: 1,
                    fontFamily: 'var(--font-mono)',
                    fontSize: '11px',
                    padding: '6px 0',
                    textAlign: 'center',
                    cursor: 'pointer',
                    borderRadius: 'var(--theme-radius)',
                    fontWeight: 800,
                    background: ch.solo ? 'var(--accent-warning)' : 'var(--bg-surface)',
                    color: ch.solo ? '#000000' : 'var(--text-secondary)',
                    border: ch.solo ? '1px solid var(--accent-warning)' : '1px solid var(--theme-border)',
                  }}
                >
                  [S]
                </button>
                <button
                  type="button"
                  onClick={() => handleToggleMute(ch.id)}
                  style={{
                    flex: 1,
                    fontFamily: 'var(--font-mono)',
                    fontSize: '11px',
                    padding: '6px 0',
                    textAlign: 'center',
                    cursor: 'pointer',
                    borderRadius: 'var(--theme-radius)',
                    fontWeight: 800,
                    background: ch.muted ? 'var(--accent-danger)' : 'var(--bg-surface)',
                    color: ch.muted ? '#ffffff' : 'var(--text-secondary)',
                    border: ch.muted ? '1px solid var(--accent-danger)' : '1px solid var(--theme-border)',
                  }}
                >
                  [M]
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {/* MASTER SECTION FOOTER */}
      <div
        style={{
          borderTop: '1px solid var(--theme-border)',
          paddingTop: '14px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '14px',
        }}
      >
        {/* EMERGENCY PANIC MUTE */}
        <button
          type="button"
          onClick={() => setPanicMuted(!panicMuted)}
          className="btn-stage"
          style={{
            background: panicMuted ? 'var(--accent-danger)' : 'rgba(239, 68, 68, 0.12)',
            color: panicMuted ? '#ffffff' : 'var(--accent-danger)',
            border: '1px solid var(--accent-danger)',
            padding: '10px 18px',
            fontSize: '12px',
          }}
        >
          <PanicIcon size={15} />
          <span>{panicMuted ? 'DESACTIVAR CORTE' : 'PANIC: SILENCIAR IN-EAR'}</span>
        </button>

        {/* MASTER VOLUME FADER */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ textAlign: 'right' }}>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '10px',
                fontWeight: 700,
                letterSpacing: '1px',
                color: 'var(--text-secondary)',
              }}
            >
              VOLUMEN GENERAL
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '13px',
                fontWeight: 800,
                color: 'var(--accent-active)',
              }}
            >
              {formatDb(masterVolume)}
            </div>
          </div>

          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={masterVolume}
            onChange={(e) => handleMasterChange(parseFloat(e.target.value))}
            style={{ width: '150px', cursor: 'pointer', accentColor: 'var(--accent-active)' }}
          />

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontFamily: 'var(--font-mono)',
              fontSize: '10px',
              color: 'var(--accent-success)',
              border: '1px solid var(--accent-success)',
              background: 'rgba(16, 185, 129, 0.1)',
              padding: '4px 8px',
              borderRadius: 'var(--theme-radius)',
            }}
          >
            <ShieldIcon size={12} />
            <span>LIMITER -0.5 dBFS</span>
          </div>
        </div>
      </div>
    </div>
  )
}
