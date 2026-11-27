import React, { useState } from 'react'
import { Check, GitBranch, GitCommit, Headphones, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { DEFAULT_STUDIO_BRANCHES, diffStudioSessions, type StudioSessionDiff } from '../../services/studio/studioVcs'
import { useStudio, type StudioPanelProps } from './studioState'

/**
 * Panel de Control de Versiones Musical del Estudio DAW:
 *   - Ramas / variantes (`main`, `vivo`, `acustico` o personalizadas)
 *   - Snapshots inmutables con cero duplicacion de WAV/FLAC/MP3 en R2 e IndexedDB
 *   - Conmutador A/B en 0 ms reales (sin detener reproduccion ni contaminar deshacer)
 *   - Visor de diferencias musicales legibles (`diffStudioSessions`) antes de restaurar
 */
export const StudioVersionPanel: React.FC<StudioPanelProps> = ({ controller }) => {
  const snap = useStudio(controller)
  const { vcs, abState, recording } = snap
  const [message, setMessage] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [creatingBranch, setCreatingBranch] = useState(false)
  const [diffCommitId, setDiffCommitId] = useState<string | null>(null)
  const [diffData, setDiffData] = useState<StudioSessionDiff | null>(null)
  const [loadingDiff, setLoadingDiff] = useState(false)

  const branches = Array.from(new Set([...DEFAULT_STUDIO_BRANCHES, ...Object.keys(vcs.index.branches), vcs.activeBranch]))
  const branchCommits = vcs.index.commits.filter((c) => c.branch === vcs.activeBranch)
  const otherCommits = vcs.index.commits.filter((c) => c.branch !== vcs.activeBranch)

  const handleCommit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (recording || vcs.saving) return
    await controller.commitVcsSnapshot(message.trim() || `Mezcla (${vcs.activeBranch})`)
    setMessage('')
  }

  const handleCreateBranch = async (e: React.FormEvent) => {
    e.preventDefault()
    const clean = newBranch.trim()
    if (!clean || recording) return
    setCreatingBranch(false)
    setNewBranch('')
    await controller.switchVcsBranch(clean)
  }

  // Borrar una rama guardada es de Owner y MusicDirector; main no se borra (STUDIO_V2.md 7.2).
  const canDeleteBranch = controller.canManageVcsBranches() && vcs.activeBranch !== 'main' && Boolean(vcs.index.branches[vcs.activeBranch])

  const handleDeleteBranch = async () => {
    const branch = vcs.activeBranch
    if (!window.confirm(`¿Borrar la rama "${branch}" y sus versiones? Los audios quedan protegidos 30 días en la nube.`)) return
    await controller.deleteVcsBranch(branch)
  }

  const toggleDiff = async (commitId: string) => {
    if (diffCommitId === commitId) {
      setDiffCommitId(null)
      setDiffData(null)
      return
    }
    setLoadingDiff(true)
    setDiffCommitId(commitId)
    const targetSession = await controller.loadVcsCommitSession(commitId)
    setLoadingDiff(false)
    if (!targetSession) {
      setDiffData(null)
      return
    }
    setDiffData(diffStudioSessions(targetSession, snap.session))
  }

  return (
    <div className="stu-vcs-panel" data-testid="studio-version-panel">
      <section className="stu-section" aria-label="Rama y comparación A/B">
        <div className="stu-param-head">
          <span className="stu-label">
            <GitBranch size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Rama activa
          </span>
          {abState && (
            <button
              type="button"
              className="stu-btn"
              data-size="small"
              data-on={abState.active === 'B'}
              data-tone={abState.active === 'B' ? 'primary' : undefined}
              disabled={recording}
              onClick={() => void controller.toggleAbListening()}
              title={`Conmutar al instante entre A (edición actual) y B (${abState.label}) — Shift+B`}
              data-testid="studio-vcs-ab-toggle"
            >
              <Headphones size={12} />
              {abState.active === 'A' ? 'ESCUCHANDO A (ACTUAL)' : `ESCUCHANDO B (${abState.label.slice(0, 16)})`}
            </button>
          )}
        </div>

        <div className="stu-fx-pick">
          <select
            className="stu-field"
            value={vcs.activeBranch}
            disabled={recording || vcs.saving}
            onChange={(e) => void controller.switchVcsBranch(e.target.value)}
            aria-label="Seleccionar rama de la sesión"
            data-testid="studio-vcs-branch-select"
          >
            {branches.map((b) => (
              <option key={b} value={b}>
                {b} {vcs.index.branches[b] ? '· guardada' : '· nueva'}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="stu-btn"
            data-size="small"
            disabled={recording}
            onClick={() => setCreatingBranch((v) => !v)}
            title="Crear nueva variante o arreglo (ej. festival, intro-larga)"
          >
            <Plus size={12} />
            RAMA
          </button>
          {canDeleteBranch && (
            <button
              type="button"
              className="stu-btn"
              data-size="small"
              data-tone="danger"
              disabled={recording || vcs.saving}
              onClick={() => void handleDeleteBranch()}
              title={`Borrar la rama "${vcs.activeBranch}" y sus versiones (solo Owner o director musical)`}
              data-testid="studio-vcs-branch-delete"
            >
              <Trash2 size={12} />
              BORRAR
            </button>
          )}
        </div>

        {creatingBranch && (
          <form className="stu-fx-pick" onSubmit={(e) => void handleCreateBranch(e)}>
            <input
              type="text"
              className="stu-field"
              placeholder="Nombre de variante (ej. vivo-arena)"
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              maxLength={32}
            />
            <button type="submit" className="stu-btn" data-size="small" data-tone="primary" disabled={!newBranch.trim()}>
              CREAR
            </button>
          </form>
        )}

        <form className="stu-vcs-commit-form" onSubmit={(e) => void handleCommit(e)}>
          <input
            type="text"
            className="stu-field"
            placeholder={`Mensaje del snapshot en "${vcs.activeBranch}"...`}
            value={message}
            disabled={recording || vcs.saving}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={120}
            data-testid="studio-vcs-message-input"
          />
          <button
            type="submit"
            className="stu-btn"
            data-tone="primary"
            disabled={recording || vcs.saving}
            title="Guardar versión inmutable sin duplicar audios (Alt+G)"
            data-testid="studio-vcs-commit-btn"
          >
            <GitCommit size={13} />
            {vcs.saving ? 'GUARDANDO...' : 'GUARDAR SNAPSHOT'}
          </button>
        </form>
      </section>

      <section className="stu-section" aria-label="Historial de versiones">
        <span className="stu-label">
          Versiones en "{vcs.activeBranch}" ({branchCommits.length})
        </span>
        {branchCommits.length === 0 ? (
          <p className="stu-help">
            Todavía no hay snapshots en esta rama. Guarda uno antes de hacer cambios grandes de mezcla o estructura para comparar A/B al instante.
          </p>
        ) : (
          <ul className="stu-vcs-list" data-testid="studio-vcs-commit-list">
            {branchCommits.map((commit) => {
              const isRefB = abState?.commitId === commit.id
              const showingDiff = diffCommitId === commit.id
              return (
                <li key={commit.id} className="stu-vcs-item" data-selected={isRefB}>
                  <div className="stu-vcs-item-head">
                    <strong>{commit.message}</strong>
                    <span className="stu-label">
                      {commit.authorName} · {new Date(commit.createdAt).toLocaleString('es', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className="stu-label">
                      {commit.trackCount} pistas · {commit.bpm} BPM{commit.key ? ` · ${commit.key}` : ''}
                    </span>
                  </div>
                  <div className="stu-actions">
                    <button
                      type="button"
                      className="stu-btn"
                      data-size="small"
                      data-on={isRefB}
                      disabled={recording}
                      onClick={() => void controller.setAbReferenceCommit(isRefB ? null : commit.id)}
                      title="Usar esta versión como referencia B para comparar audio en vivo"
                    >
                      <Check size={11} />
                      {isRefB ? 'REF B ACTIVA' : 'FIJAR B'}
                    </button>
                    <button
                      type="button"
                      className="stu-btn"
                      data-size="small"
                      data-on={showingDiff}
                      onClick={() => void toggleDiff(commit.id)}
                    >
                      DIFF
                    </button>
                    <button
                      type="button"
                      className="stu-btn"
                      data-size="small"
                      disabled={recording}
                      onClick={() => void controller.restoreVcsCommit(commit.id)}
                      title="Restaurar esta versión (se puede deshacer con Ctrl+Z)"
                    >
                      <RotateCcw size={11} />
                      RESTAURAR
                    </button>
                  </div>

                  {showingDiff && (
                    <div className="stu-vcs-diff" data-testid={`studio-vcs-diff-${commit.id}`}>
                      {loadingDiff ? (
                        <span className="stu-help">Calculando diferencias musicales...</span>
                      ) : !diffData || !diffData.changed ? (
                        <span className="stu-help">Idéntica al estado actual de la sesión.</span>
                      ) : (
                        <ul className="stu-vcs-diff-list">
                          {diffData.summary.map((line, idx) => (
                            <li key={idx}>{line}</li>
                          ))}
                          {diffData.tracks.map((td) => (
                            <li key={td.trackId}>
                              <strong>{td.name}</strong> ({td.status === 'added' ? 'nueva' : td.status === 'removed' ? 'quitada' : 'editada'}): {td.changes.join(', ')}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {otherCommits.length > 0 && (
          <>
            <span className="stu-label">Otras ramas ({otherCommits.length})</span>
            <ul className="stu-vcs-list">
              {otherCommits.slice(0, 8).map((commit) => (
                <li key={commit.id} className="stu-vcs-item">
                  <div className="stu-vcs-item-head">
                    <strong>
                      [{commit.branch}] {commit.message}
                    </strong>
                    <span className="stu-label">{commit.authorName}</span>
                  </div>
                  <div className="stu-actions">
                    <button type="button" className="stu-btn" data-size="small" disabled={recording} onClick={() => void controller.setAbReferenceCommit(commit.id)}>
                      COMPARAR B
                    </button>
                    <button type="button" className="stu-btn" data-size="small" disabled={recording} onClick={() => void controller.switchVcsBranch(commit.branch)}>
                      IR A RAMA
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  )
}
