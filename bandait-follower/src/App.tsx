import { useState, useEffect, useCallback } from 'react'
import StageView from './views/StageView'
import ConnectView, { ConnectRequest } from './views/ConnectView'
import LibraryView from './views/LibraryView'
import SettingsView, { ThemeStyle } from './views/SettingsView'
import { FollowerManualModal } from './components/FollowerManualModal'
import { session } from './services/sessionController'
import { flywheelClock } from './services/flywheelClock'
import { protocolRoleFor } from './services/identity'
import { currentPageContext, decideConnection } from './services/connectionGuard'

export type AppView = 'connect' | 'stage' | 'library' | 'settings'

const SELECTED_SETLIST_KEY = 'bandait_selected_setlist'

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage blocked: keep the in-memory value.
  }
}

function readVolume(key: string, fallback: number): number {
  const raw = readStorage(key)
  const v = raw === null ? NaN : parseFloat(raw)
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback
}

function App() {
  const [view, setView] = useState<AppView>('connect')
  const [previousView, setPreviousView] = useState<AppView>('connect')
  const [showManualModal, setShowManualModal] = useState(false)
  const [selectedSetlistId, setSelectedSetlistId] = useState<string | null>(() => readStorage(SELECTED_SETLIST_KEY))

  useEffect(() => {
    const savedTheme = (readStorage('bandait_theme') as ThemeStyle) || 'theme-swiss'
    document.body.className = savedTheme
    // Restore the saved monitor levels before any audio is armed.
    flywheelClock.setVolume(readVolume('bandait_inear_vol', 0.8))
    flywheelClock.setClickVolume(readVolume('bandait_click_vol', 0.8))
  }, [])

  /** Called from ConnectView. The socket lives in the session controller, not in a view. */
  const handleConnect = useCallback((req: ConnectRequest) => {
    // Last line of defence (contract section 8): from HTTPS a LAN leader is never
    // dialed; ConnectView already offered "ABRIR DESDE EL LIDER".
    if (decideConnection(currentPageContext(), req).kind !== 'connect') return
    // Role and alias come with the request: never re-read a profile that may be stale.
    session.join({
      url: `http://${req.ip}:${req.port}`,
      sessionId: req.sessionId,
      role: protocolRoleFor(req.profile.role),
      alias: req.profile.alias,
    })
    setView('stage')
  }, [])

  const handleToLibrary = () => {
    setPreviousView(view)
    setView('library')
  }

  const handleToSettings = () => {
    setPreviousView(view)
    setView('settings')
  }

  const handleSelectSetlist = (id: string) => {
    setSelectedSetlistId(id)
    writeStorage(SELECTED_SETLIST_KEY, id)
    setView('stage')
  }

  /** SALIR: the only place that ends the session. */
  const handleExit = () => {
    session.leave()
    setView('connect')
  }

  const handleBack = () => {
    setView(previousView || 'connect')
  }

  return (
    <div className="app-container">
      {view === 'connect' && (
        <ConnectView
          onConnect={handleConnect}
          onArmAudio={() => void flywheelClock.armAudio()}
          onSettings={handleToSettings}
          onLibrary={handleToLibrary}
          onManual={() => setShowManualModal(true)}
        />
      )}
      {view === 'stage' && (
        <StageView
          setlistId={selectedSetlistId}
          onLibrary={handleToLibrary}
          onSettings={handleToSettings}
          onExit={handleExit}
        />
      )}
      {view === 'library' && (
        <LibraryView
          selectedSetlistId={selectedSetlistId}
          onSelectSetlist={handleSelectSetlist}
          onBack={handleBack}
        />
      )}
      {view === 'settings' && <SettingsView onBack={handleBack} />}

      {showManualModal && <FollowerManualModal onClose={() => setShowManualModal(false)} />}
    </div>
  )
}

export default App
