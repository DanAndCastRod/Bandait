import { useState, useEffect } from 'react'
import { SettingsIcon, ShieldIcon, FlywheelIcon, VolumeIcon } from '../components/Icons'

export type ThemeStyle = 'theme-swiss' | 'theme-milspec' | 'theme-tokyo' | 'theme-concert'

interface Props {
  onBack: () => void
}

interface ThemeOption {
  id: ThemeStyle
  name: string
  subtitle: string
  fonts: string
  colors: string[]
}

const THEMES: ThemeOption[] = [
  {
    id: 'theme-swiss',
    name: 'SWISS BAUHAUS LAB',
    subtitle: 'Predeterminado • Racionalismo métrico clínico',
    fonts: 'Space Grotesk + IBM Plex Mono',
    colors: ['#0A0C10', '#FFFFFF', '#FF4500', '#0066FF'],
  },
  {
    id: 'theme-milspec',
    name: 'MIL-SPEC AVIONICS HUD',
    subtitle: 'Alta visibilidad 3 metros • Fósforo ámbar',
    fonts: 'Bebas Neue + Share Tech Mono',
    colors: ['#05070A', '#FFB000', '#FF8000', '#FF2200'],
  },
  {
    id: 'theme-tokyo',
    name: 'TOKYO 1989 VFD',
    subtitle: 'Fluorescente cian • Sampler vintage Akai/Roland',
    fonts: 'Orbitron + Silkscreen',
    colors: ['#02060A', '#00F0FF', '#FF0077', '#00FFAA'],
  },
  {
    id: 'theme-concert',
    name: 'CONCERT HALL',
    subtitle: 'Bronce bruñido • Terciopelo sinfónico monumental',
    fonts: 'Cinzel + Playfair Display',
    colors: ['#0A0708', '#D4AF37', '#A31D31', '#E6C875'],
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
    <div className="settings-view">
      {/* HEADER */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
        <button
          type="button"
          onClick={onBack}
          className="btn-stage btn-stage-secondary"
          style={{ padding: '8px 16px', fontSize: '12px' }}
        >
          [VOLVER AL STAGE]
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <SettingsIcon size={18} style={{ color: 'var(--accent-active)' }} />
          <h2 style={{ fontFamily: 'var(--font-mono)', fontSize: '18px', letterSpacing: '1.5px', margin: 0 }}>
            CONFIGURACIÓN DEL TERMINAL
          </h2>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            color: 'var(--accent-success)',
            border: '1px solid var(--accent-success)',
            background: 'rgba(16, 185, 129, 0.1)',
            padding: '4px 10px',
            borderRadius: 'var(--theme-radius)',
          }}
        >
          <ShieldIcon size={12} />
          <span>LIMITADOR -0.5 dBFS OK</span>
        </div>
      </div>

      {/* SECCION 1: TEMAS VISUALES CLIENTE */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '12px' }}>
          <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--text-secondary)', letterSpacing: '1px', textTransform: 'uppercase' }}>
            // ESTILO VISUAL DEL MONITOR (PERSONALIZABLE POR MÚSICO)
          </h3>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-disabled)' }}>
            LOCAL STORAGE PERSISTENTE
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '12px' }}>
          {THEMES.map((theme) => {
            const isSelected = currentTheme === theme.id
            return (
              <div
                key={theme.id}
                onClick={() => handleThemeChange(theme.id)}
                className={`theme-card-preview ${isSelected ? 'active' : ''}`}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: '13px', letterSpacing: '0.5px', color: 'var(--text-primary)' }}>
                    {theme.name}
                  </span>
                  {isSelected && (
                    <span
                      style={{
                        fontSize: '10px',
                        fontFamily: 'var(--font-mono)',
                        fontWeight: 800,
                        background: 'var(--accent-active)',
                        color: 'var(--bg-primary)',
                        padding: '2px 6px',
                        borderRadius: 'var(--theme-radius)',
                      }}
                    >
                      ACTIVO
                    </span>
                  )}
                </div>

                <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  {theme.subtitle}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '4px' }}>
                  <div style={{ fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'var(--text-disabled)' }}>
                    {theme.fonts}
                  </div>
                  {/* Color swatches */}
                  <div style={{ display: 'flex', gap: '4px' }}>
                    {theme.colors.map((c, idx) => (
                      <span
                        key={idx}
                        style={{
                          width: '12px',
                          height: '12px',
                          borderRadius: '2px',
                          background: c,
                          border: '1px solid rgba(255, 255, 255, 0.2)',
                          display: 'inline-block',
                        }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* SECCION 2: MEZCLADOR DE MONITOREO PERSONAL */}
      <div>
        <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '14px', letterSpacing: '1px', textTransform: 'uppercase' }}>
          // CALIBRACIÓN DE RETORNO IN-EAR (3 VÍAS CON LIMITADOR SEGURO)
        </h3>

        <div
          style={{
            background: 'var(--theme-card-bg)',
            border: '1px solid var(--theme-border)',
            borderRadius: 'var(--theme-radius)',
            padding: '18px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            maxWidth: '560px',
          }}
        >
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: '11px', marginBottom: '6px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <VolumeIcon size={13} />
                <span>CANAL 1: CLIC METRÓNOMO</span>
              </span>
              <span style={{ fontWeight: 700, color: 'var(--accent-active)' }}>{Math.round(clickVolume * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={clickVolume}
              onChange={(e) => handleVolumeChange('click', parseFloat(e.target.value))}
              style={{ width: '100%', accentColor: 'var(--accent-active)', cursor: 'pointer' }}
            />
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: '11px', marginBottom: '6px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <VolumeIcon size={13} />
                <span>CANAL 2: GUÍA VOCAL / TALKBACK</span>
              </span>
              <span style={{ fontWeight: 700, color: 'var(--accent-active)' }}>{Math.round(guideVolume * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={guideVolume}
              onChange={(e) => handleVolumeChange('guide', parseFloat(e.target.value))}
              style={{ width: '100%', accentColor: 'var(--accent-active)', cursor: 'pointer' }}
            />
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: '11px', marginBottom: '6px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <VolumeIcon size={13} />
                <span>CANAL 3: STEMS PRE-CACHE</span>
              </span>
              <span style={{ fontWeight: 700, color: 'var(--accent-active)' }}>{Math.round(stemsVolume * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={stemsVolume}
              onChange={(e) => handleVolumeChange('stems', parseFloat(e.target.value))}
              style={{ width: '100%', accentColor: 'var(--accent-active)', cursor: 'pointer' }}
            />
          </div>
        </div>
      </div>

      {/* SECCION 3: RESILIENCIA & MOTOR FLYWHEEL */}
      <div
        style={{
          border: '1px solid var(--theme-border)',
          borderRadius: 'var(--theme-radius)',
          padding: '16px 20px',
          background: 'var(--theme-card-bg)',
          maxWidth: '640px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <FlywheelIcon size={16} style={{ color: 'var(--accent-warning)' }} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>
              MOTOR FLYWHEEL AUTÓNOMO (RESILIENCIA EN VIVO)
            </span>
          </div>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--accent-success)', fontWeight: 700 }}>
            [ACTIVO]
          </span>
        </div>
        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.6' }}>
          En caso de caída o microcortes de red Wi-Fi en el escenario, el oscilador Web Audio local mantendrá el compás y pulso por inercia matemática sin silencios abruptos. Al reconectar con el líder FOH, ejecutará una realineación de fase suave (soft phase-alignment) sin romper la experiencia auditiva.
        </p>
      </div>
    </div>
  )
}
