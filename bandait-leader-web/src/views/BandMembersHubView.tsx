import React, { useState } from 'react'
import { useHub, type HubActionResult } from '../context/hubContextCore'
import type { MemberRole } from '../types/hub'
import { Users, UserPlus, Shield, Mail, Phone, CheckCircle2, Share2, Copy, LogOut, UserMinus } from 'lucide-react'

const MONO = "'IBM Plex Mono', monospace"

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Enlace de invitacion con boton de copiar (el Hub no envia correos: se manda por el canal de la banda). */
const InviteLinkBox: React.FC<{ link: string }> = ({ link }) => {
  const [copied, setCopied] = useState<boolean | null>(null)
  return (
    <div data-testid="invite-link" style={{ display: 'flex', gap: '8px', alignItems: 'stretch', flexWrap: 'wrap' }}>
      <input
        readOnly
        value={link}
        aria-label="Enlace de invitación"
        onFocus={(e) => e.currentTarget.select()}
        style={{
          flex: '1 1 220px',
          minWidth: 0,
          background: '#0d1017',
          border: '1px solid #2a3346',
          borderRadius: '4px',
          padding: '8px 10px',
          color: '#e2e8f0',
          fontFamily: MONO,
          fontSize: '11px',
        }}
      />
      <button
        type="button"
        onClick={() => void copyToClipboard(link).then(setCopied)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          background: '#1a202c',
          border: '1px solid #2a3346',
          borderRadius: '4px',
          padding: '8px 12px',
          color: copied ? '#10b981' : '#e2e8f0',
          fontFamily: MONO,
          fontSize: '11px',
          fontWeight: 700,
          cursor: 'pointer',
        }}
      >
        <Copy size={13} />
        {copied === null ? 'COPIAR ENLACE' : copied ? 'COPIADO' : 'COPIA A MANO'}
      </button>
    </div>
  )
}

const resultBox = (result: HubActionResult): React.CSSProperties => ({
  background: result.ok ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.12)',
  border: `1px solid ${result.ok ? 'rgba(16, 185, 129, 0.4)' : '#ef4444'}`,
  borderRadius: '4px',
  padding: '10px 14px',
  color: result.ok ? '#a7f3d0' : '#fca5a5',
  fontSize: '12px',
  fontFamily: MONO,
  lineHeight: 1.5,
})

const noteBox: React.CSSProperties = {
  background: 'rgba(245, 158, 11, 0.1)',
  border: '1px solid rgba(245, 158, 11, 0.4)',
  borderRadius: '4px',
  padding: '10px 14px',
  color: '#fcd34d',
  fontSize: '12px',
  fontFamily: MONO,
  lineHeight: 1.5,
}

export const BandMembersHubView: React.FC = () => {
  const {
    activeBand,
    activeBandRole,
    members,
    updateMemberRole,
    inviteMember,
    removeMember,
    leaveActiveBand,
    shareActiveBand,
    roleEditBlockReason,
    sharing,
    user,
  } = useHub()
  const [showInviteModal, setShowInviteModal] = useState(false)
  const [roleError, setRoleError] = useState<string | null>(null)
  const [inviteName, setInviteName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<MemberRole>('Musician')
  const [inviteInstrument, setInviteInstrument] = useState('')
  const [inviteBusy, setInviteBusy] = useState(false)
  const [inviteResult, setInviteResult] = useState<HubActionResult | null>(null)
  const [shareBusy, setShareBusy] = useState(false)
  const [panelResult, setPanelResult] = useState<HubActionResult | null>(null)

  const isShared = sharing.activeShared
  // Un resultado (y su enlace) es de una banda: al cambiar de banda no debe quedar a la vista.
  const visiblePanelResult = panelResult && (!panelResult.bandId || panelResult.bandId === activeBand?.id) ? panelResult : null
  const isCreator = !!activeBand && !!user && activeBand.ownerId === user.id
  const canInvite = !isShared || sharing.activeCanInvite

  const openInvite = () => {
    setInviteResult(null)
    setShowInviteModal(true)
  }

  const handleInviteSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!inviteName.trim() || !inviteEmail.trim() || inviteBusy) return
    setInviteBusy(true)
    const result = await inviteMember(inviteName.trim(), inviteEmail.trim(), inviteRole, inviteInstrument.trim() || 'Instrumentista')
    setInviteBusy(false)
    setInviteResult(result)
    if (result.ok) {
      setInviteName('')
      setInviteEmail('')
      setInviteInstrument('')
    }
  }

  const handleShare = async () => {
    if (shareBusy) return
    setShareBusy(true)
    const result = await shareActiveBand()
    setPanelResult({ bandId: activeBand?.id, ...result })
    setShareBusy(false)
  }

  const handleLeave = async () => {
    if (!activeBand || !window.confirm(`¿Salir de ${activeBand.name}? Dejarás de verla hasta que te vuelvan a invitar.`)) return
    setPanelResult(await leaveActiveBand())
  }

  const handleRemove = async (memberId: string, name: string) => {
    if (!window.confirm(`¿Quitar a ${name} de la banda? Perderá el acceso.`)) return
    const result = await removeMember(memberId)
    setPanelResult({ bandId: activeBand?.id, ...result })
  }

  const handleRoleChange = (memberId: string, newRole: MemberRole) => {
    const result = updateMemberRole(memberId, newRole)
    setRoleError(result.ok ? null : result.reason || 'Cambio de rol no permitido.')
  }

  const roleColors: Record<MemberRole, string> = {
    Owner: '#ef4444',
    MusicDirector: '#ff4500',
    SoundEngineer: '#0066ff',
    Musician: '#10b981',
    Substitute: '#f59e0b',
  }

  return (
    <div style={{ padding: 'clamp(12px, 3vw, 24px)', display: 'flex', flexDirection: 'column', gap: '16px' }}>
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
          onClick={openInvite}
          disabled={!canInvite}
          title={canInvite ? 'Invitar integrante' : 'Solo el Owner y el MusicDirector invitan'}
          style={{
            opacity: canInvite ? 1 : 0.5,
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
            cursor: canInvite ? 'pointer' : 'not-allowed',
            boxShadow: '0 0 12px rgba(16, 185, 129, 0.3)',
          }}
        >
          <UserPlus size={16} />
          <span>INVITAR INTEGRANTE</span>
        </button>
      </div>

      {/* ROLE GUARD NOTICE */}
      <div
        data-testid="role-guard-note"
        style={{
          background: '#0d1017',
          border: '1px solid #2a3346',
          borderRadius: '4px',
          padding: '10px 14px',
          fontSize: '11px',
          color: '#94a3b8',
          fontFamily: "'IBM Plex Mono', monospace",
          lineHeight: 1.5,
        }}
      >
        {isShared
          ? 'REGLAS DE ROLES: Owner y MusicDirector editan canciones y setlists e invitan; solo un Owner cambia roles o quita integrantes. Lo hace cumplir el servidor (permisos por banda).'
          : 'REGLAS DE ROLES: solo un Owner cambia roles, nadie cambia su propio rol y siempre queda al menos un Owner. En una banda sin compartir es una validación de este navegador: compártela para que valga en el servidor.'}
      </div>

      {/* SHARING PANEL */}
      <div
        data-testid="sharing-panel"
        style={{
          background: '#131720',
          border: `1px solid ${isShared ? 'rgba(16, 185, 129, 0.4)' : '#2a3346'}`,
          borderRadius: '6px',
          padding: '14px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <Share2 size={16} style={{ color: isShared ? '#10b981' : '#94a3b8' }} />
          <strong style={{ fontFamily: MONO, fontSize: '12px', letterSpacing: '1px' }}>
            {isShared ? `BANDA COMPARTIDA · TU ROL: ${activeBandRole ?? '-'}` : 'BANDA SOLO EN TU CUENTA'}
          </strong>
        </div>
        {isShared ? (
          <>
            <p style={{ margin: 0, fontSize: '12px', color: '#94a3b8', lineHeight: 1.5 }}>
              Cada integrante entra al Hub con "Continuar con Google" usando el correo invitado y ve las mismas canciones y
              setlists. Bandait no envía correos: manda este enlace por el chat de la banda.
            </p>
            {sharing.activeLink && <InviteLinkBox key={sharing.activeLink} link={sharing.activeLink} />}
            {!sharing.activeCanEdit && (
              <p style={{ margin: 0, fontSize: '12px', color: '#f59e0b', fontFamily: MONO }}>
                Tu rol es de solo lectura: puedes estudiar el repertorio pero no editarlo.
              </p>
            )}
            {!isCreator && (
              <button
                type="button"
                onClick={() => void handleLeave()}
                style={{
                  alignSelf: 'flex-start',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  background: 'transparent',
                  border: '1px solid #2a3346',
                  borderRadius: '4px',
                  padding: '6px 12px',
                  color: '#94a3b8',
                  fontFamily: MONO,
                  fontSize: '11px',
                  cursor: 'pointer',
                }}
              >
                <LogOut size={13} /> SALIR DE LA BANDA
              </button>
            )}
          </>
        ) : sharing.cloudSignedIn ? (
          <>
            <p style={{ margin: 0, fontSize: '12px', color: '#94a3b8', lineHeight: 1.5 }}>
              Al compartirla, {activeBand?.name} pasa a la nube como banda propia: los integrantes de esta lista que tengan correo
              quedan invitados y podrás invitar a más. En el líder, vuelve a elegirla en Cuenta &gt; Elegir banda.
            </p>
            <button
              type="button"
              data-testid="share-band"
              onClick={() => void handleShare()}
              disabled={shareBusy || sharing.available === false}
              title={sharing.available === false ? sharing.error ?? '' : 'Compartir banda'}
              style={{
                alignSelf: 'flex-start',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                background: '#0066ff',
                border: 'none',
                borderRadius: '4px',
                padding: '8px 14px',
                color: '#ffffff',
                fontFamily: MONO,
                fontSize: '12px',
                fontWeight: 700,
                cursor: shareBusy || sharing.available === false ? 'not-allowed' : 'pointer',
                opacity: shareBusy || sharing.available === false ? 0.6 : 1,
              }}
            >
              <Share2 size={14} /> {shareBusy ? 'COMPARTIENDO...' : 'COMPARTIR BANDA'}
            </button>
            {sharing.available === false && sharing.error && (
              <p style={{ margin: 0, fontSize: '11px', color: '#fca5a5', fontFamily: MONO }}>{sharing.error}</p>
            )}
          </>
        ) : (
          <p style={{ margin: 0, fontSize: '12px', color: '#94a3b8', lineHeight: 1.5 }}>
            Para compartir esta banda con otros integrantes entra con "Continuar con Google (nube)". Con un perfil local los
            datos viven solo en este navegador.
          </p>
        )}
        {visiblePanelResult && (
          <div role="status" data-testid="sharing-result" style={resultBox(visiblePanelResult)}>
            {visiblePanelResult.message}
            {visiblePanelResult.ok && visiblePanelResult.link && !isShared && (
              <div style={{ marginTop: '8px' }}>
                <InviteLinkBox key={visiblePanelResult.link} link={visiblePanelResult.link} />
              </div>
            )}
          </div>
        )}
      </div>

      {roleError && (
        <div
          role="alert"
          data-testid="role-error"
          style={{
            background: 'rgba(239, 68, 68, 0.12)',
            border: '1px solid #ef4444',
            borderRadius: '4px',
            padding: '10px 14px',
            color: '#fca5a5',
            fontSize: '12px',
            fontFamily: "'IBM Plex Mono', monospace",
          }}
        >
          [ROLES]: {roleError}
        </div>
      )}

      {/* MEMBERS TABLE */}
      <div
        className="touch-scroll-x"
        style={{
          background: '#131720',
          border: '1px solid #2a3346',
          borderRadius: '6px',
          overflowX: 'auto',
          WebkitOverflowScrolling: 'touch',
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
            {members.map((member, idx) => {
              const blockReason = roleEditBlockReason(member.id)
              return (
              <tr
                key={member.id}
                data-testid={`member-row-${member.id}`}
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
                    onChange={(e) => handleRoleChange(member.id, e.target.value as MemberRole)}
                    disabled={blockReason !== null}
                    title={blockReason ?? 'Cambiar rol'}
                    aria-label={`Rol de ${member.name}`}
                    style={{
                      opacity: blockReason ? 0.55 : 1,
                      background: '#1a202c',
                      border: `1px solid ${roleColors[member.role] || '#2a3346'}`,
                      borderRadius: '4px',
                      padding: '6px 10px',
                      color: roleColors[member.role] || '#ffffff',
                      fontFamily: "'IBM Plex Mono', monospace",
                      fontSize: '11px',
                      fontWeight: 700,
                      outline: 'none',
                      cursor: blockReason ? 'not-allowed' : 'pointer',
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
                      whiteSpace: 'nowrap',
                      color: isShared ? '#10b981' : '#94a3b8',
                      background: isShared ? 'rgba(16, 185, 129, 0.1)' : 'transparent',
                      border: `1px solid ${isShared ? 'rgba(16, 185, 129, 0.3)' : '#2a3346'}`,
                      padding: '2px 8px',
                      borderRadius: '3px',
                    }}
                  >
                    {isShared && <CheckCircle2 size={11} />}
                    <span>{isShared ? 'CON ACCESO' : 'SOLO EN LA LISTA'}</span>
                  </div>
                  {isShared && activeBandRole === 'Owner' && member.userId !== activeBand?.ownerId && (
                    <button
                      type="button"
                      onClick={() => void handleRemove(member.id, member.name)}
                      title={`Quitar a ${member.name}`}
                      aria-label={`Quitar a ${member.name}`}
                      style={{
                        marginLeft: '8px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        background: 'transparent',
                        border: '1px solid #2a3346',
                        borderRadius: '3px',
                        padding: '2px 8px',
                        color: '#fca5a5',
                        fontFamily: MONO,
                        fontSize: '10px',
                        cursor: 'pointer',
                      }}
                    >
                      <UserMinus size={11} /> QUITAR
                    </button>
                  )}
                </td>
              </tr>
              )
            })}
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
            padding: '16px',
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              background: '#161b26',
              border: '1px solid #2a3346',
              borderRadius: '8px',
              padding: 'clamp(16px, 4vw, 24px)',
              width: '100%',
              maxWidth: '440px',
              maxHeight: '90dvh',
              overflowY: 'auto',
            }}
          >
            <h3 style={{ margin: '0 0 16px 0', fontFamily: "'IBM Plex Mono', monospace", fontSize: '16px' }}>
              INVITAR INTEGRANTE A {activeBand?.name.toUpperCase()}
            </h3>

            <form onSubmit={(e) => void handleInviteSubmit(e)} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {!isShared && (
                <div style={noteBox}>
                  {sharing.cloudSignedIn
                    ? 'Esta banda aún no está compartida: la persona quedará solo en la lista. Usa COMPARTIR BANDA para que pueda entrar.'
                    : 'Perfil local: la persona quedará solo en la lista de este navegador.'}
                </div>
              )}
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
                  <option value="Musician">Músico (solo lectura)</option>
                  <option value="MusicDirector">Director Musical (edita)</option>
                  <option value="SoundEngineer">Ingeniero FOH (solo lectura)</option>
                  <option value="Substitute">Músico Suplente (solo lectura)</option>
                  {isShared && activeBandRole === 'Owner' && <option value="Owner">Dueño (Owner)</option>}
                </select>
              </div>

              {inviteResult && (
                <div role="status" data-testid="invite-result" style={resultBox(inviteResult)}>
                  {inviteResult.message}
                  {inviteResult.link && (
                    <div style={{ marginTop: '8px' }}>
                      <InviteLinkBox key={inviteResult.link} link={inviteResult.link} />
                    </div>
                  )}
                </div>
              )}

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
                  {inviteResult?.ok ? 'CERRAR' : 'CANCELAR'}
                </button>
                <button
                  type="submit"
                  disabled={inviteBusy}
                  style={{
                    background: '#10b981',
                    border: 'none',
                    color: '#ffffff',
                    padding: '8px 20px',
                    borderRadius: '4px',
                    fontWeight: 700,
                    cursor: inviteBusy ? 'wait' : 'pointer',
                    opacity: inviteBusy ? 0.6 : 1,
                  }}
                >
                  {inviteBusy ? 'INVITANDO...' : isShared ? 'DAR ACCESO' : 'AGREGAR A LA LISTA'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
