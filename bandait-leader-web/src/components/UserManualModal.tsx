import React, { useState } from 'react'
import {
  BookOpen,
  Sliders,
  Wifi,
  Users,
  Radio,
  X,
  ShieldCheck,
  Zap,
} from 'lucide-react'

interface Props {
  onClose: () => void
}

type ManualSection = 'topology' | 'quickstart' | 'routing' | 'flywheel' | 'roles'

export const UserManualModal: React.FC<Props> = ({ onClose }) => {
  const [activeSection, setActiveSection] = useState<ManualSection>('quickstart')

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        background: 'rgba(0, 0, 0, 0.88)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '16px',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          background: '#12151c',
          border: '1px solid #2a3346',
          borderRadius: '8px',
          width: '100%',
          maxWidth: '820px',
          maxHeight: '90dvh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 24px 48px rgba(0, 0, 0, 0.9)',
        }}
      >
        {/* MODAL HEADER */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid #2a3346',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: '#161b26',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                background: 'rgba(0, 102, 255, 0.15)',
                border: '1px solid #0066ff',
                borderRadius: '4px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#0066ff',
              }}
            >
              <BookOpen size={18} />
            </div>
            <div>
              <div
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontWeight: 800,
                  fontSize: '14px',
                  letterSpacing: '1px',
                  color: '#ffffff',
                }}
              >
                MANUAL DE USUARIO & GUIA TECNICA // BANDAIT 3.0
              </div>
              <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                Sistema Operativo en Vivo para Escenarios, Ensayo y Administracion de Repertorio
              </div>
            </div>
          </div>

          <button
            onClick={onClose}
            title="Cerrar Manual"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              padding: '6px',
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* HORIZONTAL SECTION TABS */}
        <div
          className="touch-scroll-x"
          style={{
            display: 'flex',
            gap: '4px',
            background: '#0d1017',
            padding: '8px 12px',
            borderBottom: '1px solid #2a3346',
            overflowX: 'auto',
          }}
        >
          {[
            { id: 'quickstart', label: '1. INICIO RAPIDO', icon: <Zap size={14} /> },
            { id: 'topology', label: '2. TOPOLOGIA ESCENARIO', icon: <Radio size={14} /> },
            { id: 'routing', label: '3. RUTEO ASIO & STEMS', icon: <Sliders size={14} /> },
            { id: 'flywheel', label: '4. RELOJ FLYWHEEL', icon: <Wifi size={14} /> },
            { id: 'roles', label: '5. ROLES DE BANDA', icon: <Users size={14} /> },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveSection(tab.id as ManualSection)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 12px',
                background: activeSection === tab.id ? '#1a202c' : 'transparent',
                border: activeSection === tab.id ? '1px solid #0066ff' : '1px solid transparent',
                borderRadius: '4px',
                color: activeSection === tab.id ? '#ffffff' : '#94a3b8',
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: '11px',
                fontWeight: activeSection === tab.id ? 700 : 400,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* CONTENT BODY */}
        <div style={{ padding: 'clamp(16px, 3vw, 24px)', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* SECTION 1: QUICKSTART */}
          {activeSection === 'quickstart' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ borderLeft: '3px solid #0066ff', paddingLeft: '12px' }}>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>Guia de Puesta en Marcha (5 Pasos de Roadie)</h3>
                <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: '#94a3b8' }}>
                  Sigue este flujo para programar tu show, conectar a los musicos y operar en vivo con cero caidas.
                </p>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
                {[
                  {
                    step: 'PASO 01',
                    title: 'Acceso e Identidad',
                    desc: 'Inicia sesion con Google o vincula tu cuenta personal. Tu espacio de trabajo y bandas se guardan de forma aislada y persistente.',
                  },
                  {
                    step: 'PASO 02',
                    title: 'Crear el Setlist',
                    desc: 'Agrega canciones con tempo BPM, tono original, tono de show y clave armonica Camelot para transiciones fluidas sin choques.',
                  },
                  {
                    step: 'PASO 03',
                    title: 'Matriz de Pistas WAV',
                    desc: 'Sube las pistas de audio o stems Demucs de 6 canales. Ajusta las ganancias con limitador de proteccion auditiva a -0.5 dBFS.',
                  },
                  {
                    step: 'PASO 04',
                    title: 'Conectar a los Musicos',
                    desc: 'Los musicos escanean el QR con su telefono o entran a la PWA Follower para recibir clic, compas y acordes sincronizados.',
                  },
                  {
                    step: 'PASO 05',
                    title: 'Disparar el Show',
                    desc: 'El Director controla el transporte (Play, Stop, Siguiente) desde la laptop o desde su smartphone con precedencia compartida.',
                  },
                ].map((item, idx) => (
                  <div
                    key={idx}
                    style={{
                      background: '#161b26',
                      border: '1px solid #2a3346',
                      borderRadius: '6px',
                      padding: '14px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "'IBM Plex Mono', monospace",
                        fontSize: '11px',
                        color: '#ff4500',
                        fontWeight: 800,
                      }}
                    >
                      {item.step}
                    </span>
                    <strong style={{ fontSize: '14px', color: '#ffffff' }}>{item.title}</strong>
                    <p style={{ margin: 0, fontSize: '12px', color: '#94a3b8', lineHeight: 1.5 }}>
                      {item.desc}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* SECTION 2: TOPOLOGY */}
          {activeSection === 'topology' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ borderLeft: '3px solid #10b981', paddingLeft: '12px' }}>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>Topologia de Escenario e Infraestructura FOH</h3>
                <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: '#94a3b8' }}>
                  Bandait esta disenado con arquitectura "Offline-First". El show nunca depende de internet en el auditorio.
                </p>
              </div>

              <div
                style={{
                  background: '#0a0c10',
                  border: '1px solid #2a3346',
                  borderRadius: '6px',
                  padding: '16px',
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: '12px',
                  color: '#e2e8f0',
                  lineHeight: 1.6,
                  overflowX: 'auto',
                }}
              >
                <div style={{ color: '#0066ff', fontWeight: 700, marginBottom: '8px' }}>
                  DIAGRAMA DE CONEXIONES FISICAS & RED LOCAL //
                </div>
                <pre style={{ margin: 0 }}>
{`[ LAPTOP FOH // DIRECTOR ]
    |
    +--- (USB Audio) ---> [ INTERFAZ ASIO PRO ]
    |                         +--- Salidas 1-2 (XLR Balanceado) ---> PA Main Sala
    |                         +--- Salida 3 (Jack 1/4" Directo) ----> Clic Cable Baterista
    |
    +--- (Ethernet / Wi-Fi 5 GHz) ---> [ ROUTER LOCAL DEDICADO ]
                                            |
                                            +--- Wi-Fi Local ---> [ Smartphone Director ] (Control Mando)
                                            +--- Wi-Fi Local ---> [ Smartphone Cantante ] (Letras & Clic)
                                            +--- Wi-Fi Local ---> [ Smartphone Guitarra ] (Acordes & Tempo)
                                            +--- Wi-Fi Local ---> [ Tablet Tecladista ]  (Partituras/In-Ear)`}
                </pre>
              </div>

              <div style={{ background: '#161b26', border: '1px solid #2a3346', borderRadius: '6px', padding: '14px', fontSize: '12px', color: '#94a3b8', lineHeight: 1.5 }}>
                <strong style={{ color: '#10b981' }}>REGLA DE ORO DE ESCENARIO:</strong> Utiliza siempre un router Wi-Fi de 5 GHz propio en la tarima, sin contrasenas publicas. Los smartphones se conectan a esa red interna y reciben paquetes ligeros de sincronizacion NTP (&lt; 1 KB/s).
              </div>
            </div>
          )}

          {/* SECTION 3: ROUTING & STEMS */}
          {activeSection === 'routing' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ borderLeft: '3px solid #ff4500', paddingLeft: '12px' }}>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>Ruteo ASIO & Matriz de Stems Demucs</h3>
                <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: '#94a3b8' }}>
                  Separacion fija de 6 canales en 24-bit / 48 kHz con limitador estricto de proteccion auditiva.
                </p>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '12px' }}>
                {[
                  { ch: 'CH 01-02', name: 'Master PA / Secuencias', dest: 'Salidas 1 y 2 FOH (Sala)', notes: 'Bases, sintes y coros que van a los altavoces del publico.' },
                  { ch: 'CH 03', name: 'Guitarras / Armonia', dest: 'Bus In-Ear Cuerdas', notes: 'Guitarras electricas y acusticas aisladas para monitoreo.' },
                  { ch: 'CH 04', name: 'Vocal Guide / Claqueta Voz', dest: 'Bus In-Ear Toda la Banda', notes: 'Conteo hablado ("Intro, 2, 3, 4", "Coro ahora").' },
                  { ch: 'CH 05', name: 'Metronomo / Clic de Ataque', dest: 'Salida 3 Cable Baterista', notes: 'Onda sintetizada con ataque de 5ms enviada por cable sin jitter.' },
                  { ch: 'CH 06', name: 'Bajo / Low-End Stems', dest: 'Bus In-Ear Bajo & Bateria', notes: 'Frecuencias sub-graves controladas para el pulso ritmico.' },
                ].map((track, i) => (
                  <div key={i} style={{ background: '#161b26', border: '1px solid #2a3346', borderRadius: '6px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: '11px', color: '#0066ff', fontWeight: 700 }}>{track.ch}</span>
                      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: '9px', background: 'rgba(16, 185, 129, 0.1)', color: '#10b981', padding: '2px 5px', borderRadius: '3px' }}>-0.5 dBFS OK</span>
                    </div>
                    <strong style={{ fontSize: '13px', color: '#ffffff' }}>{track.name}</strong>
                    <div style={{ fontSize: '11px', color: '#ff4500', fontFamily: "'IBM Plex Mono', monospace" }}>{track.dest}</div>
                    <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8' }}>{track.notes}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* SECTION 4: FLYWHEEL */}
          {activeSection === 'flywheel' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ borderLeft: '3px solid #f59e0b', paddingLeft: '12px' }}>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>Mecanismo Flywheel: Inercia Ritmica Autonoma</h3>
                <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: '#94a3b8' }}>
                  Que sucede si el baterista o cantante camina detras de una columna de concreto y pierde la senal Wi-Fi?
                </p>
              </div>

              <div style={{ background: '#161b26', border: '1px solid #2a3346', borderRadius: '6px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                  <div style={{ background: 'rgba(245, 158, 11, 0.15)', padding: '8px', borderRadius: '4px', color: '#f59e0b' }}>
                    <Zap size={20} />
                  </div>
                  <div>
                    <strong style={{ fontSize: '14px', color: '#ffffff' }}>Tolerancia Absoluta a Desconexion:</strong>
                    <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: '#94a3b8', lineHeight: 1.5 }}>
                      A diferencia de los reproductores comunes de streaming que se congelan al perder paquetes, Bandait Follower tiene un motor Flywheel en Web Audio API. El telefono sigue marcando el pulso matematicamente en el compas exacto.
                    </p>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                  <div style={{ background: 'rgba(16, 185, 129, 0.15)', padding: '8px', borderRadius: '4px', color: '#10b981' }}>
                    <ShieldCheck size={20} />
                  </div>
                  <div>
                    <strong style={{ fontSize: '14px', color: '#ffffff' }}>Soft Phase-Alignment (Reconexion Silenciosa):</strong>
                    <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: '#94a3b8', lineHeight: 1.5 }}>
                      Cuando el dispositivo recupera la antena Wi-Fi, el reloj no pega un frenazo abrupto. Realiza un micro-ajuste de fase en 4 compases hasta alinearse con el reloj FOH de la laptop sin que el musico lo perciba.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* SECTION 5: ROLES */}
          {activeSection === 'roles' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ borderLeft: '3px solid #a855f7', paddingLeft: '12px' }}>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>Vistas Adaptativas por Rol de Musico</h3>
                <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: '#94a3b8' }}>
                  Cada instrumento en vivo requiere una interfaz diferente para no distraer en plena actuacion.
                </p>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '12px' }}>
                {[
                  { role: 'Vocalista / Coros', focus: 'Letras grandes, cifrado sutil', detail: 'Scroll automatico sincronizado linea por linea con el compas activo.' },
                  { role: 'Baterista', focus: 'BPM gigante, flash de compas 1', detail: 'Estructura (Intro / Verso / Coro) y conteo regresivo de transicion.' },
                  { role: 'Guitarrista / Bajista', focus: 'Cifrado armonico destacado', detail: 'Acordes grandes en tipografia monoespaciada con tono show transpuesto.' },
                  { role: 'Director Musical', focus: 'Mando dual y saltos de tema', detail: 'Botones grandes para disparar temas imprevistos con alerta general a la banda.' },
                ].map((item, idx) => (
                  <div key={idx} style={{ background: '#161b26', border: '1px solid #2a3346', borderRadius: '6px', padding: '14px' }}>
                    <div style={{ color: '#a855f7', fontWeight: 800, fontSize: '13px', fontFamily: "'IBM Plex Mono', monospace" }}>{item.role}</div>
                    <div style={{ color: '#ffffff', fontWeight: 700, fontSize: '12px', marginTop: '4px' }}>{item.focus}</div>
                    <div style={{ color: '#94a3b8', fontSize: '11px', marginTop: '4px', lineHeight: 1.4 }}>{item.detail}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* FOOTER ACTION */}
        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid #2a3346',
            background: '#161b26',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '10px',
          }}
        >
          <div style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
            BANDAI SYSTEM SPEC V3.0 // 0 EMOJIS // SWISS BAUHAUS LAB
          </div>
          <button
            onClick={onClose}
            style={{
              background: '#0066ff',
              border: 'none',
              color: '#ffffff',
              borderRadius: '4px',
              padding: '8px 20px',
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: '12px',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            ENTENDIDO, VOLVER AL HUB
          </button>
        </div>
      </div>
    </div>
  )
}
