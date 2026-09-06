import { useState, useEffect, useCallback } from 'react'
import { stemCacheService, StemType } from '../services/stemCacheService'

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

  // Check stem cache status on mount and when songId changes
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
    // 0.8 -> 0 dB; 1.0 -> +2.0 dB; 0.4 -> -6 dB
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
        backgroundColor: 'rgba(10, 11, 14, 0.94)',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        backdropFilter: 'blur(8px)',
        padding: '16px',
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
          borderBottom: '2px solid var(--border-color)',
          paddingBottom: '12px',
          marginBottom: '16px',
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
                background: 'var(--accent-primary)',
                color: '#ffffff',
                padding: '2px 6px',
                borderRadius: '2px',
                letterSpacing: '1px',
                fontWeight: 700,
              }}
            >
              [IN-EAR DSP]
            </span>
            <h2
              style={{
                margin: 0,
                fontFamily: 'var(--font-display)',
                fontSize: '18px',
                textTransform: 'uppercase',
                letterSpacing: '1px',
              }}
            >
              Mezcla Multipista & Monitoreo Personal
            </h2>
          </div>
          <p
            style={{
              margin: '4px 0 0 0',
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              color: 'var(--text-muted)',
            }}
          >
            Aislamiento estéreo, balance multicanal y techo limitador acústico a -0.5 dBFS.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            onClick={onClose}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              padding: '8px 16px',
              background: 'transparent',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-color)',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            [CERRAR MEZCLADOR]
          </button>
        </div>
      </div>

      {/* TOP STATUS & PRESETS BAR */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '12px',
          marginBottom: '16px',
          background: 'rgba(255, 255, 255, 0.02)',
          border: '1px solid var(--border-color)',
          borderRadius: '4px',
          padding: '10px 14px',
        }}
      >
        {/* PRESET BUTTONS */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              color: 'var(--text-muted)',
              letterSpacing: '1px',
            }}
          >
            PRESETS:
          </span>
          {(['EQUILIBRADO', 'BATERISTA', 'CANTANTE', 'ARMONÍA'] as const).map((preset) => (
            <button
              key={preset}
              onClick={() => applyPreset(preset)}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '11px',
                padding: '4px 10px',
                borderRadius: '3px',
                cursor: 'pointer',
                background: activePreset === preset ? 'var(--accent-primary)' : 'rgba(255, 255, 255, 0.05)',
                color: activePreset === preset ? '#ffffff' : 'var(--text-secondary)',
                border: activePreset === preset ? '1px solid var(--accent-primary)' : '1px solid var(--border-color)',
                letterSpacing: '0.5px',
              }}
            >
              [{preset}]
            </button>
          ))}
        </div>

        {/* STEM CACHE STATUS & PRELOAD BUTTON */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              color: 'var(--accent-success)',
              border: '1px solid var(--accent-success)',
              padding: '3px 8px',
              borderRadius: '3px',
            }}
          >
            {cacheStatus}
          </span>
          <button
            onClick={handlePreload}
            disabled={isPreloading}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              padding: '5px 12px',
              background: isPreloading ? 'var(--border-color)' : 'rgba(32, 201, 151, 0.15)',
              color: isPreloading ? 'var(--text-muted)' : 'var(--accent-success)',
              border: '1px solid var(--accent-success)',
              borderRadius: '3px',
              cursor: isPreloading ? 'not-allowed' : 'pointer',
              fontWeight: 600,
            }}
          >
            {isPreloading ? `[DESCARGANDO ${preloadProgress}%]` : '[PRE-CARGAR STEMS]'}
          </button>
        </div>
      </div>

      {/* CHANNEL STRIPS GRID */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
          gap: '12px',
          flex: 1,
          alignItems: 'stretch',
          marginBottom: '16px',
        }}
      >
        {channels.map((ch) => {
          const isAudible = hasAnySolo ? ch.solo : !ch.muted && !panicMuted
          const isNearLimiter = ch.volume > 0.95

          return (
            <div
              key={ch.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                background: 'rgba(255, 255, 255, 0.03)',
                border: ch.solo
                  ? '1px solid #fab005'
                  : ch.muted
                  ? '1px solid rgba(255, 255, 255, 0.05)'
                  : '1px solid var(--border-color)',
                borderRadius: '6px',
                padding: '12px 8px',
                opacity: isAudible ? 1 : 0.4,
                transition: 'border-color 0.15s, opacity 0.15s',
              }}
            >
              {/* Channel Code & Name */}
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '12px',
                  fontWeight: 700,
                  letterSpacing: '1px',
                  color: isAudible ? 'var(--text-primary)' : 'var(--text-muted)',
                  marginBottom: '2px',
                }}
              >
                {ch.code}
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '9px',
                  color: 'var(--text-muted)',
                  letterSpacing: '0.5px',
                  marginBottom: '12px',
                }}
              >
                {ch.label}
              </div>

              {/* Volume dB Readout */}
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '11px',
                  color: isNearLimiter ? '#f03e3e' : 'var(--accent-primary)',
                  fontWeight: 600,
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
                    accentColor: isNearLimiter ? '#f03e3e' : 'var(--accent-primary)',
                  }}
                />
              </div>

              {/* Safety Limiter Dot */}
              <div
                style={{
                  marginTop: '6px',
                  marginBottom: '10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                <span
                  style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    backgroundColor: isNearLimiter ? '#f03e3e' : 'var(--border-color)',
                  }}
                />
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '8px',
                    color: isNearLimiter ? '#f03e3e' : 'var(--text-muted)',
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
                    fontSize: '8px',
                    color: 'var(--text-muted)',
                    display: 'flex',
                    justifyContent: 'space-between',
                  }}
                >
                  <span>L</span>
                  <span>{ch.pan === 0 ? 'C' : ch.pan > 0 ? `R${Math.round(ch.pan * 100)}` : `L${Math.round(Math.abs(ch.pan) * 100)}`}</span>
                  <span>R</span>
                </div>
                <input
                  type="range"
                  min="-1"
                  max="1"
                  step="0.05"
                  value={ch.pan}
                  onChange={(e) => handlePanChange(ch.id, parseFloat(e.target.value))}
                  style={{ width: '100%', height: '4px', cursor: 'pointer' }}
                />
              </div>

              {/* Solo & Mute Buttons */}
              <div style={{ display: 'flex', gap: '6px', width: '100%' }}>
                <button
                  onClick={() => handleToggleSolo(ch.id)}
                  style={{
                    flex: 1,
                    fontFamily: 'var(--font-mono)',
                    fontSize: '10px',
                    padding: '6px 0',
                    textAlign: 'center',
                    cursor: 'pointer',
                    borderRadius: '3px',
                    fontWeight: 700,
                    background: ch.solo ? '#fab005' : 'rgba(255, 255, 255, 0.05)',
                    color: ch.solo ? '#000000' : 'var(--text-secondary)',
                    border: ch.solo ? '1px solid #fab005' : '1px solid var(--border-color)',
                  }}
                >
                  [S]
                </button>
                <button
                  onClick={() => handleToggleMute(ch.id)}
                  style={{
                    flex: 1,
                    fontFamily: 'var(--font-mono)',
                    fontSize: '10px',
                    padding: '6px 0',
                    textAlign: 'center',
                    cursor: 'pointer',
                    borderRadius: '3px',
                    fontWeight: 700,
                    background: ch.muted ? '#f03e3e' : 'rgba(255, 255, 255, 0.05)',
                    color: ch.muted ? '#ffffff' : 'var(--text-secondary)',
                    border: ch.muted ? '1px solid #f03e3e' : '1px solid var(--border-color)',
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
          borderTop: '2px solid var(--border-color)',
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
          onClick={() => setPanicMuted(!panicMuted)}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            padding: '10px 18px',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 700,
            letterSpacing: '1px',
            background: panicMuted ? '#f03e3e' : 'rgba(240, 62, 62, 0.1)',
            color: panicMuted ? '#ffffff' : '#f03e3e',
            border: '2px solid #f03e3e',
          }}
        >
          {panicMuted ? '[DESACTIVAR CORTE DE EMERGENCIA]' : '[PANIC: SILENCIAR IN-EAR]'}
        </button>

        {/* MASTER VOLUME FADER */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ textAlign: 'right' }}>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '11px',
                fontWeight: 700,
                letterSpacing: '1px',
              }}
            >
              VOLUMEN GENERAL
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '12px',
                color: 'var(--accent-primary)',
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
            style={{ width: '140px', cursor: 'pointer' }}
          />
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '10px',
              color: 'var(--text-muted)',
              border: '1px solid var(--border-color)',
              padding: '4px 6px',
              borderRadius: '3px',
            }}
          >
            LIMITER -0.5 dBFS
          </span>
        </div>
      </div>
    </div>
  )
}
