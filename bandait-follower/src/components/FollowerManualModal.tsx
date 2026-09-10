import React, { useState } from 'react'
import {
  BookOpenIcon,
  WifiIcon,
  ShieldIcon,
  UserIcon,
  CloseIcon,
  VolumeIcon,
} from './Icons'

interface Props {
  onClose: () => void
}

type TabType = 'connect' | 'flywheel' | 'inear' | 'roles'

export const FollowerManualModal: React.FC<Props> = ({ onClose }) => {
  const [tab, setTab] = useState<TabType>('connect')

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
          background: 'var(--bg-surface, #161b26)',
          border: '1px solid var(--border-subtle, #2a3346)',
          borderRadius: '8px',
          width: '100%',
          maxWidth: '560px',
          maxHeight: '90dvh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.9)',
        }}
      >
        {/* HEADER */}
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--border-subtle, #2a3346)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'var(--bg-elevated, #1a202c)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <BookOpenIcon size={18} style={{ color: 'var(--accent-active, #0066ff)' }} />
            <h3
              style={{
                margin: 0,
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: '13px',
                fontWeight: 800,
                color: 'var(--text-primary, #ffffff)',
                letterSpacing: '1px',
              }}
            >
              MANUAL DE ESCENARIO // GUIA DEL MUSICO
            </h3>
          </div>
          <button
            onClick={onClose}
            title="Cerrar Manual"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-secondary, #94a3b8)',
              cursor: 'pointer',
              display: 'flex',
              padding: '4px',
            }}
          >
            <CloseIcon size={18} />
          </button>
        </div>

        {/* TABS */}
        <div
          style={{
            display: 'flex',
            background: 'var(--bg-primary, #0d1017)',
            borderBottom: '1px solid var(--border-subtle, #2a3346)',
            overflowX: 'auto',
          }}
        >
          {[
            { id: 'connect', label: 'CONEXION', icon: <WifiIcon size={13} /> },
            { id: 'flywheel', label: 'FLYWHEEL', icon: <ShieldIcon size={13} /> },
            { id: 'inear', label: 'IN-EAR', icon: <VolumeIcon size={13} /> },
            { id: 'roles', label: 'ROLES', icon: <UserIcon size={13} /> },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id as TabType)}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '5px',
                padding: '10px 8px',
                background: tab === t.id ? 'var(--bg-elevated, #1a202c)' : 'transparent',
                border: 'none',
                borderBottom: tab === t.id ? '2px solid var(--accent-orange, #ff4500)' : '2px solid transparent',
                color: tab === t.id ? 'var(--text-primary, #ffffff)' : 'var(--text-secondary, #94a3b8)',
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: '10px',
                fontWeight: tab === t.id ? 700 : 400,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        {/* BODY */}
        <div style={{ padding: '18px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '14px', fontSize: '12px', lineHeight: 1.5 }}>
          {tab === 'connect' && (
            <>
              <strong style={{ color: 'var(--text-primary, #ffffff)', fontSize: '13px' }}>
                Como enlazarse al sistema en el escenario:
              </strong>
              <div style={{ background: 'var(--bg-primary, #0d1017)', border: '1px solid var(--border-subtle, #2a3346)', borderRadius: '4px', padding: '12px' }}>
                <div>1. Conectate a la red Wi-Fi de 5 GHz de la banda (Hotspot del lider).</div>
                <div style={{ marginTop: '6px' }}>2. Escanea el codigo QR proyectado por el Director o ingresa la IP del lider (ej: 192.168.1.100).</div>
                <div style={{ marginTop: '6px' }}>3. Pulsa "ESTABLECER ENLACE STAGE". La sincronizacion de reloj NTP se lograra en menos de 1 segundo (offset verificado &lt; 5.1 ms).</div>
              </div>
            </>
          )}

          {tab === 'flywheel' && (
            <>
              <strong style={{ color: 'var(--text-primary, #ffffff)', fontSize: '13px' }}>
                Reloj Flywheel (Que pasa si se cae el Wi-Fi?):
              </strong>
              <p style={{ margin: 0, color: 'var(--text-secondary, #94a3b8)' }}>
                Bandait cuenta con un oscilador Web Audio local. Si caminas lejos de la antena en un solo o hay interferencias de radiofrecuencia, tu telefono no se silenciara ni perdera el compas: continuara marcando el pulso por inercia matematica.
              </p>
              <div style={{ background: 'rgba(16, 185, 129, 0.1)', border: '1px solid var(--accent-success, #10b981)', borderRadius: '4px', padding: '10px', color: 'var(--accent-success, #10b981)', fontFamily: "'IBM Plex Mono', monospace" }}>
                RECONEXION INTELIGENTE: Al volver a la cobertura, el reloj se realinea suavemente en 4 compases sin golpes de fase audibles.
              </div>
            </>
          )}

          {tab === 'inear' && (
            <>
              <strong style={{ color: 'var(--text-primary, #ffffff)', fontSize: '13px' }}>
                Monitoreo In-Ear & Proteccion Auditiva:
              </strong>
              <p style={{ margin: 0, color: 'var(--text-secondary, #94a3b8)' }}>
                En la vista de Escenario puedes ajustar tu mezcla personal de audifonos (Volumen de Clic, Guia de Voz y Stems) usando los faders graduados en dB.
              </p>
              <div style={{ background: 'var(--bg-primary, #0d1017)', border: '1px solid var(--border-subtle, #2a3346)', borderRadius: '4px', padding: '10px', fontFamily: "'IBM Plex Mono', monospace" }}>
                LIMITADOR DE SEGURIDAD: Todos los retornos de audio pasan por un limitador de picos calibrado a -0.5 dBFS para proteger tu audicion contra ruidos de acople o transientes imprevistos.
              </div>
            </>
          )}

          {tab === 'roles' && (
            <>
              <strong style={{ color: 'var(--text-primary, #ffffff)', fontSize: '13px' }}>
                Vistas Optimizadas por Instrumento:
              </strong>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <div style={{ background: 'var(--bg-primary, #0d1017)', border: '1px solid var(--border-subtle, #2a3346)', borderRadius: '4px', padding: '10px' }}>
                  <span style={{ color: 'var(--accent-orange, #ff4500)', fontWeight: 700 }}>VOCALISTA</span>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary, #94a3b8)', marginTop: '4px' }}>Letras grandes y scroll automatico sincronizado.</div>
                </div>
                <div style={{ background: 'var(--bg-primary, #0d1017)', border: '1px solid var(--border-subtle, #2a3346)', borderRadius: '4px', padding: '10px' }}>
                  <span style={{ color: 'var(--accent-active, #0066ff)', fontWeight: 700 }}>BATERISTA</span>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary, #94a3b8)', marginTop: '4px' }}>BPM gigante y pulso visual de compas 1.</div>
                </div>
                <div style={{ background: 'var(--bg-primary, #0d1017)', border: '1px solid var(--border-subtle, #2a3346)', borderRadius: '4px', padding: '10px' }}>
                  <span style={{ color: 'var(--accent-success, #10b981)', fontWeight: 700 }}>CUERDAS</span>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary, #94a3b8)', marginTop: '4px' }}>Cifrado armonico y tono transpuesto.</div>
                </div>
                <div style={{ background: 'var(--bg-primary, #0d1017)', border: '1px solid var(--border-subtle, #2a3346)', borderRadius: '4px', padding: '10px' }}>
                  <span style={{ color: 'var(--accent-warning, #f59e0b)', fontWeight: 700 }}>DIRECTOR</span>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary, #94a3b8)', marginTop: '4px' }}>Mando maestro y alerta de saltos de tema.</div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* FOOTER */}
        <div
          style={{
            padding: '12px 18px',
            borderTop: '1px solid var(--border-subtle, #2a3346)',
            display: 'flex',
            justifyContent: 'flex-end',
            background: 'var(--bg-elevated, #1a202c)',
          }}
        >
          <button
            onClick={onClose}
            style={{
              background: 'var(--accent-active, #0066ff)',
              border: 'none',
              color: '#ffffff',
              borderRadius: '4px',
              padding: '8px 16px',
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: '11px',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            CERRAR GUIA
          </button>
        </div>
      </div>
    </div>
  )
}
