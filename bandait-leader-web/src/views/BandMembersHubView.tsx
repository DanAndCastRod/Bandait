import React, { useState } from 'react'
import { useHub } from '../context/HubContext'
import type { MemberRole } from '../types/hub'
import { Users, UserPlus, Shield, Mail, Phone, CheckCircle2 } from 'lucide-react'

export const BandMembersHubView: React.FC = () => {
  const { activeBand, members, updateMemberRole, inviteMember } = useHub()
  const [showInviteModal, setShowInviteModal] = useState(false)
  const [inviteName, setInviteName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<MemberRole>('Musician')
  const [inviteInstrument, setInviteInstrument] = useState('')

  const handleInviteSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!inviteName.trim() || !inviteEmail.trim()) return
    inviteMember(inviteName.trim(), inviteEmail.trim(), inviteRole, inviteInstrument.trim() || 'Instrumentista')
    setInviteName('')
    setInviteEmail('')
    setInviteInstrument('')
    setShowInviteModal(false)
  }

  const roleColors: Record<MemberRole, string> = {
    Owner: '#ef4444',
    MusicDirector: '#ff4500',
    SoundEngineer: '#0066ff',
    Musician: '#10b981',
    Substitute: '#f59e0b',
  }

  return (
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* HEADER BAR */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '16px',
          borderBottom: '1px solid #2a3346',
          paddingBottom: '16px',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Users size={22} style={{ color: '#10b981' }} />
            <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 800, letterSpacing: '-0.5px' }}>
              Integrantes & Matriz de Roles
            </h2>
          </div>
          <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: '#94a3b8' }}>
            Gestiona los miembros de {activeBand?.name}, asigna roles y permisos de acceso para ensayo y show en vivo.
          </p>
        </div>

        <button
          onClick={() => setShowInviteModal(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            background: '#10b981',
            border: 'none',
            borderRadius: '4px',
            padding: '10px 18px',
            color: '#ffffff',
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: '12px',
            fontWeight: 700,
            cursor: 'pointer',
            boxShadow: '0 0 12px rgba(16, 185, 129, 0.3)',
          }}
        >
          <UserPlus size={16} />
          <span>INVITAR INTEGRANTE</span>
        </button>
      </div>

      {/* MEMBERS TABLE */}
      <div
        style={{
          background: '#131720',
          border: '1px solid #2a3346',
          borderRadius: '6px',
          overflowX: 'auto',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
          <thead>
            <tr
              style={{
                borderBottom: '1px solid #2a3346',
                background: '#1a202c',
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: '10px',
                color: '#94a3b8',
                letterSpacing: '1px',
              }}
            >
              <th style={{ padding: '12px 16px' }}>INTEGRANTE</th>
              <th style={{ padding: '12px 16px' }}>INSTRUMENTO / FUNCIÓN</th>
              <th style={{ padding: '12px 16px' }}>CONTACTO</th>
              <th style={{ padding: '12px 16px' }}>ROL EN LA BANDA</th>
              <th style={{ padding: '12px 16px' }}>ESTADO</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member, idx) => (
              <tr
                key={member.id}
                style={{
                  borderBottom: '1px solid #1f2737',
                  background: idx % 2 === 0 ? '#131720' : '#11141c',
                }}
              >
                {/* NAME */}
                <td style={{ padding: '14px 16px' }}>
                  <div style={{ fontWeight: 700, fontSize: '14px', color: '#ffffff' }}>{member.name}</div>
                  <div style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                    {member.email}
                  </div>
                </td>

                {/* INSTRUMENT */}
                <td style={{ padding: '14px 16px', fontSize: '13px', color: '#e2e8f0', fontWeight: 600 }}>
                  {member.instrument}
                </td>

                {/* CONTACT */}
                <td style={{ padding: '14px 16px', fontFamily: "'IBM Plex Mono', monospace", fontSize: '11px', color: '#94a3b8' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Mail size={11} /> {member.email}
                    </span>
                    {member.phone && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <Phone size={11} /> {member.phone}
                      </span>
                    )}
                  </div>
                </td>

                {/* ROLE SELECTOR */}
                <td style={{ padding: '14px 16px' }}>
                  <select
                    value={member.role}
                    onChange={(e) => updateMemberRole(member.id, e.target.value as MemberRole)}
                    style={{
                      background: '#1a202c',
                      border: `1px solid ${roleColors[member.role] || '#2a3346'}`,
                      borderRadius: '4px',
                      padding: '6px 10px',
                      color: roleColors[member.role] || '#ffffff',
                      fontFamily: "'IBM Plex Mono', monospace",
                      fontSize: '11px',
                      fontWeight: 700,
                      outline: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    <option value="Owner">Dueño (Owner)</option>
                    <option value="MusicDirector">Director Musical</option>
                    <option value="SoundEngineer">Ingeniero FOH</option>
                    <option value="Musician">Músico</option>
                    <option value="Substitute">Músico Suplente</option>
                  </select>
                </td>

                {/* STATUS */}
                <td style={{ padding: '14px 16px' }}>
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      fontFamily: "'IBM Plex Mono', monospace",
                      fontSize: '10px',
                      color: '#10b981',
                      background: 'rgba(16, 185, 129, 0.1)',
                      border: '1px solid rgba(16, 185, 129, 0.3)',
                      padding: '2px 8px',
                      borderRadius: '3px',
                    }}
                  >
                    <CheckCircle2 size={11} />
                    <span>ENLACE ACTIVO</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* PERMISSIONS MATRIX */}
      <div
        style={{
          background: '#131720',
          border: '1px solid #2a3346',
          borderRadius: '6px',
          padding: '18px 20px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
          <Shield size={16} style={{ color: '#0066ff' }} />
          <h4 style={{ margin: 0, fontSize: '13px', fontFamily: "'IBM Plex Mono', monospace", letterSpacing: '1px' }}>
            MATRIZ DE PRIVILEGIOS POR ROL
          </h4>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px', fontSize: '11px', color: '#94a3b8' }}>
          <div>• <strong>Owner / Director:</strong> Control total, edición de setlist, ruteo multicanal y borrado.</div>
          <div>• <strong>SoundEngineer:</strong> Ajuste de salidas ASIO, vúmetros y mezcla PA.</div>
          <div>• <strong>Musician:</strong> Control de mezcla personal in-ear y lectura de acordes.</div>
          <div>• <strong>Substitute:</strong> Acceso seguro a notas de canciones sin permisos de edición.</div>
        </div>
      </div>

      {/* INVITE MODAL */}
      {showInviteModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: 'rgba(0, 0, 0, 0.85)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: '#161b26',
              border: '1px solid #2a3346',
              borderRadius: '8px',
              padding: '24px',
              width: '100%',
              maxWidth: '440px',
            }}
          >
            <h3 style={{ margin: '0 0 16px 0', fontFamily: "'IBM Plex Mono', monospace", fontSize: '16px' }}>
              INVITAR INTEGRANTE A {activeBand?.name.toUpperCase()}
            </h3>

            <form onSubmit={handleInviteSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                  NOMBRE COMPLETO
                </label>
                <input
                  type="text"
                  value={inviteName}
                  onChange={(e) => setInviteName(e.target.value)}
                  placeholder="Ej: Daniel Restrepo"
                  required
                  style={{
                    width: '100%',
                    background: '#0d1017',
                    border: '1px solid #2a3346',
                    borderRadius: '4px',
                    padding: '8px 10px',
                    color: '#ffffff',
                    marginTop: '4px',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                  CORREO ELECTRÓNICO (GOOGLE ACCOUNT)
                </label>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="ejemplo@gmail.com"
                  required
                  style={{
                    width: '100%',
                    background: '#0d1017',
                    border: '1px solid #2a3346',
                    borderRadius: '4px',
                    padding: '8px 10px',
                    color: '#ffffff',
                    marginTop: '4px',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                  INSTRUMENTO O FUNCIÓN
                </label>
                <input
                  type="text"
                  value={inviteInstrument}
                  onChange={(e) => setInviteInstrument(e.target.value)}
                  placeholder="Ej: Batería / Guitarra / Coros"
                  required
                  style={{
                    width: '100%',
                    background: '#0d1017',
                    border: '1px solid #2a3346',
                    borderRadius: '4px',
                    padding: '8px 10px',
                    color: '#ffffff',
                    marginTop: '4px',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontFamily: "'IBM Plex Mono', monospace" }}>
                  ROL ASIGNADO
                </label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as MemberRole)}
                  style={{
                    width: '100%',
                    background: '#0d1017',
                    border: '1px solid #2a3346',
                    borderRadius: '4px',
                    padding: '8px 10px',
                    color: '#ffffff',
                    marginTop: '4px',
                    boxSizing: 'border-box',
                  }}
                >
                  <option value="Musician">Músico</option>
                  <option value="MusicDirector">Director Musical</option>
                  <option value="SoundEngineer">Ingeniero FOH</option>
                  <option value="Substitute">Músico Suplente</option>
                </select>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
                <button
                  type="button"
                  onClick={() => setShowInviteModal(false)}
                  style={{
                    background: 'transparent',
                    border: '1px solid #2a3346',
                    color: '#94a3b8',
                    padding: '8px 16px',
                    borderRadius: '4px',
                    cursor: 'pointer',
                  }}
                >
                  CANCELAR
                </button>
                <button
                  type="submit"
                  style={{
                    background: '#10b981',
                    border: 'none',
                    color: '#ffffff',
                    padding: '8px 20px',
                    borderRadius: '4px',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  ENVIAR INVITACIÓN
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
