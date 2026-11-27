import React, { useState } from 'react'
import { GitBranch, GitCommit, Plus, RotateCcw } from 'lucide-react'
import { useHub } from '../context/hubContextCore'
import {
  DEFAULT_ECOSYSTEM_BRANCHES,
  diffPlaylists,
  diffSongs,
  emptyEntityHistory,
} from '../services/versionControl'
import type { Playlist, Song } from '../types/hub'
import { HubModal } from './HubModal'
import { cardStyle, colors, ghostButton, inputStyle, labelStyle, mono, primaryButton, radius } from './hubStyles'

type Target =
  | { kind: 'song'; entity: Song }
  | { kind: 'playlist'; entity: Playlist }

interface Props {
  target: Target
  onClose: () => void
}

/**
 * Modal de Control de Versiones Musical (estilo Git) para Canciones y Setlists:
 *   - Ramas / variantes (`main`, `vivo`, `acustico` o personalizadas)
 *   - Snapshots con autor y mensaje
 *   - Comparacion estructural legible (`diffSongs` / `diffPlaylists`) antes de restaurar
 */
export const EntityHistoryModal: React.FC<Props> = ({ target, onClose }) => {
  const {
    bandVcs,
    sharing,
    commitSongVersion,
    switchSongBranch,
    restoreSongCommit,
    commitPlaylistVersion,
    switchPlaylistBranch,
    restorePlaylistCommit,
  } = useHub()

  const [message, setMessage] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [creatingBranch, setCreatingBranch] = useState(false)
  const [diffCommitId, setDiffCommitId] = useState<string | null>(null)

  const canEdit = sharing.activeCanEdit
  const songHistory = target.kind === 'song' ? (bandVcs.songs[target.entity.id] ?? emptyEntityHistory<Song>()) : null
  const playlistHistory = target.kind === 'playlist' ? (bandVcs.playlists[target.entity.id] ?? emptyEntityHistory<Playlist>()) : null

  const activeBranch = songHistory ? songHistory.activeBranch : playlistHistory!.activeBranch
  const branchesMap = songHistory ? songHistory.branches : playlistHistory!.branches
  const allBranches = Array.from(new Set([...DEFAULT_ECOSYSTEM_BRANCHES, ...Object.keys(branchesMap), activeBranch]))
  const entityLabel = target.kind === 'song' ? target.entity.title : target.entity.name

  const handleCommit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canEdit) return
    const msg = message.trim() || `Snapshot (${activeBranch})`
    if (target.kind === 'song') {
      commitSongVersion(target.entity.id, msg, activeBranch)
    } else {
      commitPlaylistVersion(target.entity.id, msg, activeBranch)
    }
    setMessage('')
  }

  const handleBranchSwitch = (branch: string) => {
    if (!canEdit) return
    if (target.kind === 'song') {
      switchSongBranch(target.entity.id, branch)
    } else {
      switchPlaylistBranch(target.entity.id, branch)
    }
  }

  const handleCreateBranch = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canEdit || !newBranch.trim()) return
    const clean = newBranch.trim()
    setNewBranch('')
    setCreatingBranch(false)
    handleBranchSwitch(clean)
  }

  const handleRestore = (commitId: string) => {
    if (!canEdit) return
    if (target.kind === 'song') {
      restoreSongCommit(target.entity.id, commitId)
    } else {
      restorePlaylistCommit(target.entity.id, commitId)
    }
  }

  const commits = songHistory
    ? songHistory.commits.map((c) => ({
        id: c.id,
        branch: c.branch,
        message: c.message,
        authorName: c.authorName,
        createdAt: c.createdAt,
        diffLines: diffCommitId === c.id ? diffSongs(c.snapshot, target.entity as Song).summary : null,
      }))
    : playlistHistory!.commits.map((c) => ({
        id: c.id,
        branch: c.branch,
        message: c.message,
        authorName: c.authorName,
        createdAt: c.createdAt,
        diffLines: diffCommitId === c.id ? diffPlaylists(c.snapshot, target.entity as Playlist).summary : null,
      }))

  const branchCommits = commits.filter((c) => c.branch === activeBranch)
  const otherCommits = commits.filter((c) => c.branch !== activeBranch)

  return (
    <HubModal
      title={`VERSIONES · ${entityLabel.toUpperCase().slice(0, 32)}`}
      onClose={onClose}
      maxWidth="560px"
      testId="entity-history-modal"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', fontSize: '13px' }}>
        {/* Selector de rama y creacion de variante */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
            <span style={labelStyle}>
              <GitBranch size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              RAMA / VARIANTE ACTIVA
            </span>
            <button
              type="button"
              disabled={!canEdit}
              onClick={() => setCreatingBranch((v) => !v)}
              style={{ ...ghostButton, padding: '4px 10px', fontSize: '11px' }}
            >
              <Plus size={12} /> NUEVA RAMA
            </button>
          </div>

          <select
            aria-label="Rama activa"
            value={activeBranch}
            disabled={!canEdit}
            onChange={(e) => handleBranchSwitch(e.target.value)}
            style={inputStyle}
            data-testid="entity-vcs-branch-select"
          >
            {allBranches.map((b) => (
              <option key={b} value={b}>
                {b} {branchesMap[b] ? '· con historial' : '· nueva'}
              </option>
            ))}
          </select>

          {creatingBranch && (
            <form onSubmit={handleCreateBranch} style={{ display: 'flex', gap: '8px' }}>
              <input
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                placeholder="Ej: acustico-teatro, gira-verano..."
                maxLength={32}
                style={{ ...inputStyle, flex: 1 }}
              />
              <button type="submit" disabled={!newBranch.trim()} style={primaryButton()}>
                CREAR
              </button>
            </form>
          )}
        </div>

        {/* Guardar snapshot */}
        <form onSubmit={handleCommit} style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <input
            value={message}
            disabled={!canEdit}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={`Descripción del snapshot en "${activeBranch}"...`}
            maxLength={100}
            style={{ ...inputStyle, flex: '1 1 220px' }}
            data-testid="entity-vcs-message"
          />
          <button type="submit" disabled={!canEdit} style={primaryButton()} data-testid="entity-vcs-commit">
            <GitCommit size={13} /> GUARDAR SNAPSHOT
          </button>
        </form>

        {!canEdit && (
          <div style={{ fontSize: '12px', color: colors.muted }}>
            En bandas compartidas, solo Owner o Director Musical pueden guardar o restaurar versiones oficiales.
          </div>
        )}

        {/* Lista de commits en la rama activa */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '340px', overflowY: 'auto' }}>
          <span style={labelStyle}>
            HISTORIAL EN "{activeBranch}" ({branchCommits.length})
          </span>
          {branchCommits.length === 0 ? (
            <div style={{ ...cardStyle, padding: '14px', color: colors.muted, fontSize: '12px' }}>
              Sin snapshots en esta rama todavía. Guarda uno antes de experimentar con tonos, cortes o transiciones.
            </div>
          ) : (
            branchCommits.map((commit) => (
              <div
                key={commit.id}
                data-testid="entity-vcs-commit-item"
                style={{ ...cardStyle, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontWeight: 700, color: colors.text }}>{commit.message}</div>
                    <div style={{ fontFamily: mono, fontSize: '11px', color: colors.muted }}>
                      {commit.authorName} · {new Date(commit.createdAt).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      type="button"
                      onClick={() => setDiffCommitId((cur) => (cur === commit.id ? null : commit.id))}
                      style={{ ...ghostButton, padding: '4px 10px', fontSize: '11px', borderRadius: radius.control }}
                    >
                      DIFF
                    </button>
                    <button
                      type="button"
                      disabled={!canEdit}
                      onClick={() => handleRestore(commit.id)}
                      style={{ ...ghostButton, padding: '4px 10px', fontSize: '11px', borderRadius: radius.control }}
                      data-testid="entity-vcs-restore"
                    >
                      <RotateCcw size={12} /> RESTAURAR
                    </button>
                  </div>
                </div>
                {commit.diffLines && (
                  <div
                    style={{
                      padding: '8px 10px',
                      borderRadius: radius.field,
                      background: 'var(--b-well)',
                      border: '1px solid var(--b-border-soft)',
                      fontFamily: mono,
                      fontSize: '11px',
                      color: colors.text,
                    }}
                  >
                    {commit.diffLines.length === 0 ? (
                      <span style={{ color: colors.muted }}>Idéntico a la versión activa.</span>
                    ) : (
                      <ul style={{ margin: 0, paddingLeft: '16px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        {commit.diffLines.map((line, idx) => (
                          <li key={idx}>{line}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            ))
          )}

          {otherCommits.length > 0 && (
            <>
              <span style={{ ...labelStyle, marginTop: '6px' }}>OTRAS RAMAS ({otherCommits.length})</span>
              {otherCommits.slice(0, 6).map((commit) => (
                <div
                  key={commit.id}
                  style={{ ...cardStyle, padding: '8px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}
                >
                  <div style={{ fontSize: '12px' }}>
                    <strong>[{commit.branch}]</strong> {commit.message}
                  </div>
                  <button
                    type="button"
                    disabled={!canEdit}
                    onClick={() => handleBranchSwitch(commit.branch)}
                    style={{ ...ghostButton, padding: '4px 8px', fontSize: '11px' }}
                  >
                    IR A RAMA
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </HubModal>
  )
}
