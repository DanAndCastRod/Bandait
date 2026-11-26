import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, Cloud, Layers, Plus } from 'lucide-react'
import { useHub, type HubSyncStatus } from '../../context/hubContextCore'

/** Inicial o foto del usuario, siempre circular. */
export const Avatar: React.FC<{ name: string; url?: string | null; size?: number }> = ({ name, url, size = 32 }) =>
  url ? (
    <img src={url} alt="" className="hub-avatar" style={{ width: size, height: size }} />
  ) : (
    <span aria-hidden="true" className="hub-avatar hub-avatar-initial" style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}>
      {initials(name)}
    </span>
  )

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

/**
 * Marca Bandait: dos barras (acento y texto) y la palabra. Las dos barras contrastan con el
 * fondo del rail en ambos temas (el logo anterior ponia texto claro sobre un degradado).
 */
export const BrandMark: React.FC<{ showWord?: boolean }> = ({ showWord = true }) => (
  <span className="hub-brand" data-testid="hub-logo">
    <span aria-hidden="true" className="hub-brand-bars">
      <span className="hub-brand-bar hub-brand-bar-accent" />
      <span className="hub-brand-bar hub-brand-bar-ink" />
    </span>
    {showWord ? <span className="hub-brand-word">Bandait</span> : <span className="hub-sr-only">Bandait</span>}
  </span>
)

const SYNC_LABEL: Record<HubSyncStatus['state'], { text: string; tone: 'muted' | 'info' | 'ok' | 'error' }> = {
  local_only: { text: 'SOLO LOCAL', tone: 'muted' },
  syncing: { text: 'SINCRONIZANDO', tone: 'info' },
  synced: { text: 'SINCRONIZADO', tone: 'ok' },
  error: { text: 'ERROR NUBE', tone: 'error' },
}

function syncTitle(status: HubSyncStatus): string {
  if (status.state === 'synced') return `Sincronizado con la nube (${new Date(status.at).toLocaleTimeString()})`
  return status.detail
}

/** Estado de la nube (solo local, sincronizando, sincronizado, error); abre la configuracion de Supabase. */
export const SyncButton: React.FC<{ compact?: boolean; onOpen: () => void }> = ({ compact = false, onOpen }) => {
  const { syncStatus } = useHub()
  const label = SYNC_LABEL[syncStatus.state]
  return (
    <button
      type="button"
      className="hub-chip hub-press"
      data-tone={label.tone}
      data-compact={compact ? 'true' : undefined}
      onClick={onOpen}
      title={`${label.text}: ${syncTitle(syncStatus)}`}
      data-testid="sync-status"
      data-sync-state={syncStatus.state}
      aria-label={`Estado de la nube: ${label.text}`}
    >
      <Cloud size={15} aria-hidden />
      {!compact && <span>{label.text}</span>}
    </button>
  )
}

interface BandSwitcherProps {
  /** Solo el icono (rail plegado); el nombre sigue en el arbol accesible. */
  compact?: boolean
  onNewBand: () => void
}

/**
 * Selector de banda. El menu se abre en una capa fija junto al boton para que no lo recorte el
 * rail (que tiene scroll propio) ni la cabecera movil.
 */
export const BandSwitcher: React.FC<BandSwitcherProps> = ({ compact = false, onNewBand }) => {
  const { bands, activeBand, activeBandRole, switchBand, sharing } = useHub()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(280, window.innerWidth - 16)
      const left = compact ? rect.right + 8 : Math.min(rect.left, window.innerWidth - width - 8)
      setPos({ top: compact ? rect.top : rect.bottom + 6, left: Math.max(8, left) })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, compact])

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const role = (activeBandRole ?? '').toUpperCase()

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid="band-switcher"
        className="hub-band hub-press"
        data-compact={compact ? 'true' : undefined}
        aria-expanded={open}
        aria-haspopup="true"
        title={compact ? `Banda: ${activeBand?.name ?? ''}` : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <Layers size={16} className="hub-band-icon" aria-hidden />
        <span className={compact ? 'hub-sr-only' : 'hub-band-name'}>{activeBand ? activeBand.name : 'Banda'}</span>
        {!compact && role && <span className="hub-badge">{role}</span>}
        {!compact && <ChevronDown size={14} className="hub-band-chevron" aria-hidden />}
      </button>

      {open && (
        <div
          ref={menuRef}
          className="hub-popover"
          aria-label="Tus agrupaciones"
          style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
        >
          <div className="hub-popover-title">Tus agrupaciones</div>
          {bands.map((b) => {
            const active = b.id === activeBand?.id
            return (
              <button
                key={b.id}
                type="button"
                className="hub-popover-item hub-press"
                data-active={active ? 'true' : undefined}
                aria-current={active ? 'true' : undefined}
                onClick={() => {
                  switchBand(b.id)
                  setOpen(false)
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span className="hub-popover-item-title">{b.name}</span>
                  <span className="hub-popover-item-sub">{b.genre}</span>
                </span>
                <span className="hub-popover-item-meta">
                  {sharing.sharedBandIds.includes(b.id) ? 'COMPARTIDA ' : ''}[{b.currentUserRole}]
                </span>
              </button>
            )
          })}
          <button
            type="button"
            className="hub-popover-item hub-popover-new hub-press"
            onClick={() => {
              setOpen(false)
              onNewBand()
            }}
          >
            <Plus size={14} aria-hidden />
            <span>Nueva agrupación</span>
          </button>
        </div>
      )}
    </>
  )
}
