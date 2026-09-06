import { useState, useEffect } from 'react'

export type ThemeStyle = 'theme-swiss' | 'theme-milspec' | 'theme-tokyo' | 'theme-concert'

interface Props {
  onBack: () => void
}

interface ThemeOption {
  id: ThemeStyle
  name: string
  subtitle: string
  fonts: string
  colors: string
}

const THEMES: ThemeOption[] = [
  {
    id: 'theme-swiss',
    name: 'SWISS BAUHAUS LAB',
    subtitle: 'Predeterminado • Racionalismo métrico',
    fonts: 'Space Grotesk + IBM Plex Mono',
    colors: '#000000 / #FFFFFF / #E11D48',
  },
  {
    id: 'theme-milspec',
    name: 'MIL-SPEC AVIONICS HUD',
    subtitle: 'Alta visibilidad 3 metros • Fósforo ámbar',
    fonts: 'Bebas Neue + Share Tech Mono',
    colors: '#050608 / #FFB000',
  },
  {
    id: 'theme-tokyo',
    name: 'TOKYO 1989 VFD',
    subtitle: 'Fluorescente cian • Sampler vintage',
    fonts: 'Orbitron + Silkscreen',
    colors: '#03070B / #00E5FF / #FF0077',
  },
  {
    id: 'theme-concert',
    name: 'CONCERT HALL',
    subtitle: 'Bronce bruñido • Terciopelo sinfónico',
    fonts: 'Cinzel + Playfair Display',
    colors: '#0A0708 / #D4AF37 / #9E1B32',
  },
]

export default function SettingsView({ onBack }: Props) {
  const [currentTheme, setCurrentTheme] = useState<ThemeStyle>(() => {
    return (localStorage.getItem('bandait_theme') as ThemeStyle) || 'theme-swiss'
  })

  const [clickVolume, setClickVolume] = useState<number>(() => {
    const saved = localStorage.getItem('bandait_click_vol')
    return saved ? parseFloat(saved) : 0.8
  })

  const [guideVolume, setGuideVolume] = useState<number>(() => {
    const saved = localStorage.getItem('bandait_guide_vol')
    return saved ? parseFloat(saved) : 0.7
  })

  const [stemsVolume, setStemsVolume] = useState<number>(() => {
    const saved = localStorage.getItem('bandait_stems_vol')
    return saved ? parseFloat(saved) : 0.9
  })

  useEffect(() => {
    localStorage.setItem('bandait_theme', currentTheme)
    document.body.className = currentTheme
  }, [currentTheme])

  const handleThemeChange = (themeId: ThemeStyle) => {
    setCurrentTheme(themeId)
  }

  const handleVolumeChange = (type: 'click' | 'guide' | 'stems', val: number) => {
    if (type === 'click') {
      setClickVolume(val)
      localStorage.setItem('bandait_click_vol', val.toString())
    } else if (type === 'guide') {
      setGuideVolume(val)
      localStorage.setItem('bandait_guide_vol', val.toString())
    } else {
      setStemsVolume(val)
      localStorage.setItem('bandait_stems_vol', val.toString())
    }
  }

  return (
    <div className="settings-view" style={{ padding: '24px', height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <button
          onClick={onBack}
          style={{
            background: 'transparent',
            border: '1px solid var(--text-secondary)',
            color: 'var(--text-primary)',
            padding: '8px 16px',
            borderRadius: '4px',
            cursor: 'pointer',
            fontFamily: 'var(--font-mono)',
            fontSize: '14px',
          }}
        >
          [VOLVER]
        </button>
        <h2 style={{ fontFamily: 'var(--font-mono)', fontSize: '18px', letterSpacing: '2px' }}>
          CONFIGURACION STAGE
        </h2>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            color: 'var(--accent-success)',
            border: '1px solid var(--accent-success)',
            padding: '2px 8px',
            borderRadius: '3px',
          }}
        >
          LIMITER -0.5 dBFS OK
        </span>
      </div>

      {/* SECCION 1: TEMAS VISUALES CLIENTE */}
      <div style={{ marginBottom: '32px' }}>
        <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
          // ESTILO VISUAL DEL MONITOR (CLIENTE INDEPENDIENTE)
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' }}>
          {THEMES.map((theme) => {
            const isSelected = currentTheme === theme.id
            return (
              <div
                key={theme.id}
                onClick={() => handleThemeChange(theme.id)}
                style={{
                  background: isSelected ? 'var(--bg-elevated)' : 'var(--bg-surface)',
                  border: isSelected ? '2px solid var(--accent-active)' : '1px solid var(--theme-border)',
                  borderRadius: '6px',
                  padding: '14px',
                  cursor: 'pointer',
                  transition: 'border-color 0.2s',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <span style={{ fontWeight: 'bold', fontSize: '13px', letterSpacing: '1px' }}>{theme.name}</span>
                  {isSelected && (
                    <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--accent-focus)' }}>
                      [ACTIVO]
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  {theme.subtitle}
                </div>
                <div style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                  Tipografías: {theme.fonts}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* SECCION 2: MEZCLADOR DE MONITOREO IN-EAR */}
      <div style={{ marginBottom: '32px' }}>
        <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
          // MEZCLADOR PERSONAL IN-EAR (3 VIAS CON LIMITADOR -0.5 dBFS)
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '480px' }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: '12px', marginBottom: '6px' }}>
              <span>CANAL 1: CLIC METRONOMO</span>
              <span>{Math.round(clickVolume * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={clickVolume}
              onChange={(e) => handleVolumeChange('click', parseFloat(e.target.value))}
              style={{ width: '100%', accentColor: 'var(--accent-active)' }}
            />
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: '12px', marginBottom: '6px' }}>
              <span>CANAL 2: GUIA VOCAL / TALKBACK</span>
              <span>{Math.round(guideVolume * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={guideVolume}
              onChange={(e) => handleVolumeChange('guide', parseFloat(e.target.value))}
              style={{ width: '100%', accentColor: 'var(--accent-focus)' }}
            />
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: '12px', marginBottom: '6px' }}>
              <span>CANAL 3: STEMS PRE-CACHE</span>
              <span>{Math.round(stemsVolume * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={stemsVolume}
              onChange={(e) => handleVolumeChange('stems', parseFloat(e.target.value))}
              style={{ width: '100%', accentColor: 'var(--accent-success)' }}
            />
          </div>
        </div>
      </div>

      {/* SECCION 3: MOTOR FLYWHEEL RESILIENCIA */}
      <div
        style={{
          border: '1px solid var(--theme-border)',
          borderRadius: '6px',
          padding: '16px',
          background: 'var(--bg-surface)',
          maxWidth: '560px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', fontWeight: 'bold' }}>
            MOTOR FLYWHEEL AUTONOMO
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--accent-success)' }}>
            [ARMADO]
          </span>
        </div>
        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.6' }}>
          En caso de caída o jitter de red Wi-Fi, el oscilador local mantendrá el compás y tempo por inercia matemática sin silencios abruptos. Al reconectar, ejecutará una realineación de fase suave (*soft phase-alignment*).
        </p>
      </div>
    </div>
  )
}
