import React, { useEffect, useRef, useState } from 'react'
import { BookOpen, Download, Ellipsis, LogOut, PanelLeftClose, PanelLeftOpen, Plus, X } from 'lucide-react'
import { useHub } from '../../context/hubContextCore'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { GoogleIcon } from '../GoogleIcon'
import { SupabaseConfigModal } from '../SupabaseConfigModal'
import { SyncNoticeBanner } from '../SyncNoticeBanner'
import { UserManualModal } from '../UserManualModal'
import { SplitQueueIndicator } from '../SplitQueueIndicator'
import { NewBandModal, ProfileModal } from './HubAccountModals'
import { Avatar, BandSwitcher, BrandMark, SyncButton } from './HubShellParts'
import {
  DESKTOP_QUERY,
  HUB_VIEWS,
  MOBILE_BAR_VIEWS,
  readRailCollapsed,
  viewDef,
  writeRailCollapsed,
  type HubView,
  type RailScope,
} from './hubViews'

interface Props {
  view: HubView
  onSelectView: (view: HubView) => void
  /** CTA "+ Subir o separar audio": lleva a Canciones y Stems > STEMS Y PISTAS. */
  onUploadAudio: () => void
  /** Hay mini reproductor visible: el contenido deja sitio al pie. */
  hasMiniPlayer: boolean
  /** Capa flotante (mini reproductor), posicionada por global.css (.hub-mini). */
  overlay?: React.ReactNode
  children: React.ReactNode
}

function flagFromUrl(...keys: Array<[string, string]>): boolean {
  try {
    const p = new URLSearchParams(window.location.search)
    return keys.some(([k, v]) => p.get(k) === v)
  } catch {
    return false
  }
}

/**
 * Shell del Hub Web 3.0 (docs/REQUERIMIENTOS_WEB_3.0.md, seccion 2).
 * - Escritorio (>= 768 px): rail izquierdo plegable 244 / 72 px (estado en localStorage) con la
 *   marca, el selector de banda, la CTA de subir audio, las 6 vistas y, al pie, nube, manual,
 *   exportar y perfil.
 * - Movil (< 768 px): cabecera fina (marca, banda, nube, perfil) y barra inferior de 4 pildoras;
 *   "Mas" abre una hoja con el resto.
 * Los modales de perfil, banda nueva, manual y nube son los mismos en ambos.
 */
export const HubShell: React.FC<Props> = ({ view, onSelectView, onUploadAudio, hasMiniPlayer, overlay, children }) => {
  const { user, logout, exportWorkspaceJson } = useHub()
  const desktop = useMediaQuery(DESKTOP_QUERY)
  const railScope: RailScope = view === 'studio' ? 'studio' : 'hub'
  const [hubCollapsed, setHubCollapsed] = useState(() => readRailCollapsed('hub'))
  const [studioCollapsed, setStudioCollapsed] = useState(() => readRailCollapsed('studio'))
  const collapsed = railScope === 'studio' ? studioCollapsed : hubCollapsed
  const [sheetOpen, setSheetOpen] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const [showNewBand, setShowNewBand] = useState(false)
  const [showManual, setShowManual] = useState(() => flagFromUrl(['manual', '1'], ['view', 'manual']))
  const [showCloud, setShowCloud] = useState(() => flagFromUrl(['cloud', '1'], ['supabase', '1']))

  const toggleRail = () => {
    const next = !collapsed
    writeRailCollapsed(next, railScope)
    if (railScope === 'studio') setStudioCollapsed(next)
    else setHubCollapsed(next)
  }

  const modals = (
    <>
      {showProfile && <ProfileModal onClose={() => setShowProfile(false)} />}
      {showNewBand && <NewBandModal onClose={() => setShowNewBand(false)} />}
      {showManual && <UserManualModal onClose={() => setShowManual(false)} />}
      {showCloud && <SupabaseConfigModal onClose={() => setShowCloud(false)} />}
    </>
  )

  const profileTitle = user ? `Usuario: ${user.name} (${user.email}) - Ver perfil` : ''
  const hasGoogleIdentity = user?.authProvider === 'supabase' || user?.authProvider === 'google_local'

  if (desktop) {
    return (
      <div className="hub-shell" data-layout="desktop" data-rail={collapsed ? 'collapsed' : 'expanded'} data-mini={hasMiniPlayer ? 'true' : undefined}>
        <aside id="hub-rail" className="hub-rail" aria-label="Barra lateral">
          <div className="hub-rail-head">
            <BrandMark showWord={!collapsed} />
            <button
              type="button"
              className="hub-icon-btn hub-press"
              data-testid="rail-toggle"
              onClick={toggleRail}
              aria-controls="hub-rail"
              aria-expanded={!collapsed}
              aria-label={collapsed ? 'Desplegar barra lateral' : 'Plegar barra lateral'}
              title={collapsed ? 'Desplegar barra lateral' : 'Plegar barra lateral'}
            >
              {collapsed ? <PanelLeftOpen size={17} aria-hidden /> : <PanelLeftClose size={17} aria-hidden />}
            </button>
          </div>

          <BandSwitcher compact={collapsed} onNewBand={() => setShowNewBand(true)} />

          <button
            type="button"
            className="hub-cta hub-press"
            data-testid="upload-audio-cta"
            onClick={onUploadAudio}
            aria-label={collapsed ? 'Subir o separar audio' : undefined}
            title={collapsed ? 'Subir o separar audio' : undefined}
          >
            <Plus size={17} strokeWidth={2.4} aria-hidden />
            {!collapsed && <span>Subir o separar audio</span>}
          </button>

          {/* Estado de la cola Drop & Split; no ocupa nada si la cola esta vacia. */}
          <SplitQueueIndicator variant={collapsed ? 'compact' : 'full'} />

          <nav className="hub-rail-nav hub-desktop-nav" aria-label="Vistas del hub">
            {HUB_VIEWS.map((item) => {
              const active = item.id === view
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  type="button"
                  className="hub-nav-item hub-press"
                  data-testid={`tab-${item.id}`}
                  aria-current={active ? 'page' : undefined}
                  aria-label={collapsed ? item.label : undefined}
                  title={collapsed ? item.label : undefined}
                  onClick={() => onSelectView(item.id)}
                >
                  <Icon size={18} strokeWidth={1.8} aria-hidden />
                  {!collapsed && <span>{item.label}</span>}
                </button>
              )
            })}
          </nav>

          <div className="hub-rail-foot">
            <SyncButton compact={collapsed} onOpen={() => setShowCloud(true)} />
            <button
              type="button"
              className="hub-nav-item hub-nav-item-quiet hub-press"
              data-testid="open-manual"
              onClick={() => setShowManual(true)}
              aria-label={collapsed ? 'Manual' : undefined}
              title="Manual de usuario y guía técnica"
            >
              <BookOpen size={17} strokeWidth={1.8} aria-hidden />
              {!collapsed && <span>Manual</span>}
            </button>
            <button
              type="button"
              className="hub-nav-item hub-nav-item-quiet hub-press"
              data-testid="export-json"
              onClick={exportWorkspaceJson}
              aria-label={collapsed ? 'Exportar JSON' : undefined}
              title="Exportar la banda activa y el workspace completo como JSON"
            >
              <Download size={17} strokeWidth={1.8} aria-hidden />
              {!collapsed && <span>Exportar JSON</span>}
            </button>

            {user && (
              <div className="hub-profile-row">
                <button type="button" className="hub-profile b-block hub-press" onClick={() => setShowProfile(true)} title={profileTitle}>
                  <Avatar name={user.name} url={user.avatarUrl} size={32} />
                  {!collapsed && (
                    <span className="hub-profile-text">
                      <span className="hub-profile-name">
                        <span className="hub-ellipsis">{user.name}</span>
                        {hasGoogleIdentity && <GoogleIcon size={12} />}
                      </span>
                      <span className="hub-profile-email hub-ellipsis">{user.email}</span>
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className="hub-icon-btn hub-icon-btn-danger hub-press"
                  onClick={() => void logout()}
                  aria-label="Cerrar sesión"
                  title="Cerrar sesión"
                >
                  <LogOut size={16} aria-hidden />
                </button>
              </div>
            )}
          </div>
        </aside>

        <div className="hub-column">
          <SyncNoticeBanner onOpenCloud={() => setShowCloud(true)} />
          <main className="hub-main">{children}</main>
        </div>
        {overlay}
        {modals}
      </div>
    )
  }

  const inSheet = !MOBILE_BAR_VIEWS.includes(view)

  return (
    <div className="hub-shell" data-layout="mobile" data-mini={hasMiniPlayer ? 'true' : undefined}>
      <header className="hub-topbar">
        <BrandMark showWord={false} />
        <BandSwitcher onNewBand={() => setShowNewBand(true)} />
        <span style={{ flex: 1 }} />
        <SplitQueueIndicator variant="compact" align="end" />
        <SyncButton compact onOpen={() => setShowCloud(true)} />
        {user && (
          <button type="button" className="hub-avatar-btn hub-press" onClick={() => setShowProfile(true)} title={profileTitle} aria-label="Perfil y sesión">
            <Avatar name={user.name} url={user.avatarUrl} size={32} />
          </button>
        )}
      </header>
      <SyncNoticeBanner onOpenCloud={() => setShowCloud(true)} />
      <main className="hub-main">{children}</main>
      {overlay}

      <nav className="hub-mobile-nav" aria-label="Vistas del hub">
        {MOBILE_BAR_VIEWS.map((id) => {
          const item = viewDef(id)
          if (!item) return null
          const active = id === view
          const Icon = item.icon
          return (
            <button
              key={id}
              type="button"
              className="hub-pill-tab hub-press"
              data-testid={`tab-${id}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelectView(id)}
            >
              <Icon size={18} strokeWidth={1.8} aria-hidden />
              <span>{item.short}</span>
            </button>
          )
        })}
        <button
          type="button"
          className="hub-pill-tab hub-press"
          data-testid="tab-more"
          aria-current={inSheet ? 'page' : undefined}
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          onClick={() => setSheetOpen(true)}
        >
          <Ellipsis size={18} strokeWidth={1.8} aria-hidden />
          <span>Más</span>
        </button>
      </nav>

      {sheetOpen && (
        <MoreSheet
          view={view}
          onClose={() => setSheetOpen(false)}
          onSelectView={(id) => {
            setSheetOpen(false)
            onSelectView(id)
          }}
          onUploadAudio={() => {
            setSheetOpen(false)
            onUploadAudio()
          }}
          onManual={() => {
            setSheetOpen(false)
            setShowManual(true)
          }}
          onExport={() => {
            setSheetOpen(false)
            exportWorkspaceJson()
          }}
        />
      )}
      {modals}
    </div>
  )
}

interface SheetProps {
  view: HubView
  onClose: () => void
  onSelectView: (view: HubView) => void
  onUploadAudio: () => void
  onManual: () => void
  onExport: () => void
}

/** Hoja inferior "Mas" del movil: subir audio, las vistas que no caben en la barra, manual y exportar. */
const MoreSheet: React.FC<SheetProps> = ({ view, onClose, onSelectView, onUploadAudio, onManual, onExport }) => {
  const sheetRef = useRef<HTMLDivElement>(null)
  // El foco entra una sola vez al abrir: onClose cambia en cada render del shell.
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })

  useEffect(() => {
    const sheet = sheetRef.current
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    sheet?.querySelector<HTMLElement>('button')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeRef.current()
        return
      }
      if (e.key !== 'Tab' || !sheet) return
      const items = Array.from(sheet.querySelectorAll<HTMLElement>('button:not([disabled])'))
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (previous && previous.isConnected) previous.focus()
    }
  }, [])

  const sheetViews = HUB_VIEWS.filter((item) => !MOBILE_BAR_VIEWS.includes(item.id))

  return (
    <div className="hub-sheet-layer" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={sheetRef} className="hub-sheet" role="dialog" aria-modal="true" aria-label="Más opciones" data-testid="more-sheet">
        <div className="hub-sheet-head">
          <span className="hub-sheet-grip" aria-hidden="true" />
          <span className="hub-sheet-title">Más</span>
          <button type="button" className="hub-icon-btn hub-press" onClick={onClose} aria-label="Cerrar">
            <X size={18} aria-hidden />
          </button>
        </div>
        <button type="button" className="hub-cta hub-press" data-testid="upload-audio-cta" onClick={onUploadAudio}>
          <Plus size={17} strokeWidth={2.4} aria-hidden />
          <span>Subir o separar audio</span>
        </button>
        <div className="hub-sheet-list">
          {sheetViews.map((item) => {
            const Icon = item.icon
            const active = item.id === view
            return (
              <button
                key={item.id}
                type="button"
                className="hub-nav-item hub-press"
                data-testid={`tab-${item.id}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => onSelectView(item.id)}
              >
                <Icon size={18} strokeWidth={1.8} aria-hidden />
                <span>{item.short}</span>
              </button>
            )
          })}
          <button type="button" className="hub-nav-item hub-press" data-testid="open-manual" onClick={onManual}>
            <BookOpen size={18} strokeWidth={1.8} aria-hidden />
            <span>Manual</span>
          </button>
          <button type="button" className="hub-nav-item hub-press" data-testid="export-json" onClick={onExport}>
            <Download size={18} strokeWidth={1.8} aria-hidden />
            <span>Exportar JSON</span>
          </button>
        </div>
      </div>
    </div>
  )
}
