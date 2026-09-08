import React from 'react'
import { GoogleIcon } from './GoogleIcon'
import { useHub } from '../context/HubContext'
import { DEMO_PROFILES } from '../services/authService'
import { ListMusic, Sliders, Users, Radio, ShieldCheck } from 'lucide-react'

export const AuthScreen: React.FC = () => {
  const { loginWithGoogle } = useHub()

  return (
    <div
      style={{
        minHeight: '100vh',
        width: '100vw',
        background: 'radial-gradient(circle at 50% 20%, #161b26 0%, #0a0c10 80%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        boxSizing: 'border-box',
        color: '#ffffff',
        fontFamily: "'Space Grotesk', -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '540px',
          background: 'linear-gradient(180deg, #131720 0%, #0d1017 100%)',
          border: '1px solid #2a3346',
          borderRadius: '8px',
          padding: '36px 32px',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.7)',
          display: 'flex',
          flexDirection: 'column',
          gap: '24px',
          position: 'relative',
        }}
      >
        {/* TOP ACCENT LINE */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '3px',
            background: 'linear-gradient(90deg, #ff4500, #0066ff)',
            borderRadius: '8px 8px 0 0',
          }}
        />

        {/* HEADER */}
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: '11px',
              fontWeight: 700,
              color: '#ff4500',
              letterSpacing: '2px',
              marginBottom: '6px',
            }}
          >
            [BANDAIT 3.0 // CLOUD & WEB ADMIN HUB]
          </div>
          <h1
            style={{
              fontSize: '32px',
              fontWeight: 800,
              letterSpacing: '-0.5px',
              margin: '0 0 8px 0',
              color: '#ffffff',
            }}
          >
            Gestión Centralizada
          </h1>
          <p
            style={{
              fontSize: '13px',
              color: '#94a3b8',
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            Parametriza setlists, ruteo multicanal de stems, integrantes y equipamiento técnico vinculado a tu cuenta de Google.
          </p>
        </div>

        {/* GOOGLE SIGN IN BUTTON */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <button
            onClick={() => loginWithGoogle()}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px',
              background: '#ffffff',
              color: '#1f2937',
              border: 'none',
              borderRadius: '6px',
              padding: '14px 20px',
              fontSize: '15px',
              fontWeight: 700,
              cursor: 'pointer',
              boxShadow: '0 4px 12px rgba(255, 255, 255, 0.1)',
              transition: 'all 0.15s ease',
            }}
            onMouseOver={(e) => (e.currentTarget.style.filter = 'brightness(0.95)')}
            onMouseOut={(e) => (e.currentTarget.style.filter = 'brightness(1)')}
          >
            <GoogleIcon size={20} />
            <span>Continuar con Google</span>
          </button>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: '10px',
              color: '#475569',
              letterSpacing: '1px',
            }}
          >
            <div style={{ flex: 1, height: '1px', background: '#2a3346' }} />
            <span>O SELECCIONA UN PERFIL TÉCNICO DE DEMO</span>
            <div style={{ flex: 1, height: '1px', background: '#2a3346' }} />
          </div>

          {/* QUICK DEMO PROFILES */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {DEMO_PROFILES.map((prof) => (
              <button
                key={prof.id}
                onClick={() => loginWithGoogle(prof)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: '#1a202c',
                  border: '1px solid #2a3346',
                  borderRadius: '6px',
                  padding: '10px 14px',
                  color: '#ffffff',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'all 0.15s ease',
                }}
                onMouseOver={(e) => (e.currentTarget.style.borderColor = '#0066ff')}
                onMouseOut={(e) => (e.currentTarget.style.borderColor = '#2a3346')}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <img
                    src={prof.avatarUrl}
                    alt={prof.name}
                    style={{ width: '32px', height: '32px', borderRadius: '50%', objectFit: 'cover' }}
                  />
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 700 }}>{prof.name}</div>
                    <div style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                      {prof.email}
                    </div>
                  </div>
                </div>
                <span
                  style={{
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: '10px',
                    color: '#0066ff',
                    border: '1px solid rgba(0, 102, 255, 0.4)',
                    padding: '2px 8px',
                    borderRadius: '4px',
                  }}
                >
                  INGRESAR &gt;
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* 4 CORE MODULES SUMMARY BADGES */}
        <div
          style={{
            borderTop: '1px solid #2a3346',
            paddingTop: '18px',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '10px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#94a3b8' }}>
            <ListMusic size={15} style={{ color: '#ff4500' }} />
            <span>Setlists & Transición</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#94a3b8' }}>
            <Sliders size={15} style={{ color: '#0066ff' }} />
            <span>Stems & Limitador dBFS</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#94a3b8' }}>
            <Users size={15} style={{ color: '#10b981' }} />
            <span>Múltiples Bandas & Roles</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#94a3b8' }}>
            <Radio size={15} style={{ color: '#f59e0b' }} />
            <span>Racks ASIO & In-Ear RF</span>
          </div>
        </div>

        {/* FOOTER BADGE */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: '10px',
            color: '#10b981',
            background: 'rgba(16, 185, 129, 0.08)',
            border: '1px solid rgba(16, 185, 129, 0.2)',
            padding: '6px 12px',
            borderRadius: '4px',
          }}
        >
          <ShieldCheck size={13} />
          <span>AUTENTICACIÓN BLINDADA // GOOGLE OAUTH 2.0 PKCE</span>
        </div>
      </div>
    </div>
  )
}
