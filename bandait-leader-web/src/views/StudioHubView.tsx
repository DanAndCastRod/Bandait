import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  ArrowLeft,
  ArrowLeftRight,
  Check,
  CloudUpload,
  Command,
  GitBranch,
  Headphones,
  Keyboard,
  Mic,
  Music2,
  PanelBottom,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { useHub } from '../context/hubContextCore'
import { useGlobalAudioEngine } from '../context/globalAudioContextCore'
import { HubModal } from '../components/HubModal'
import { StudioDevicePanel } from '../components/studio/StudioDevicePanel'
import { StudioDeviceProbe } from '../components/studio/StudioDeviceProbe'
import { StudioCommandPalette } from '../components/studio/StudioCommandPalette'
import { createStudioCommandRegistry, StudioUiBridge, studioKeymapStorage, type StudioCommandCtx, type StudioRegistry } from '../components/studio/studioCommandHandlers'
import { StudioExportDialog } from '../components/studio/StudioExportDialog'
import { StudioShortcuts } from '../components/studio/StudioShortcuts'
import { StudioAssistant } from '../components/studio/StudioAssistant'
import { StudioCloudCleanup } from '../components/studio/StudioCloudCleanup'
import { StudioInspector } from '../components/studio/StudioInspector'
import { StudioJobsPanel } from '../components/studio/StudioJobsPanel'
import { StudioMixer } from '../components/studio/StudioMixer'
import { StudioMobileQuickSurface } from '../components/studio/StudioMobileQuickSurface'
import { StudioTimeline } from '../components/studio/StudioTimeline'
import { StudioTransport } from '../components/studio/StudioTransport'
import { StudioVersionPanel } from '../components/studio/StudioVersionPanel'
import {
  createSession,
  errorText,
  listSessionEntries,
  openSessionEntry,
  renameSessionEntry,
  StudioController,
  useStudio,
  type OpenedSession,
  type SessionEntry,
} from '../components/studio/studioState'
import { cloudBandKey, type CloudTarget } from '../services/stemCloud'
import { stemCloudTarget } from '../services/stemCloudConfig'
import { getSupabaseClient } from '../services/supabaseClient'
import {
  ASSISTANT_LAYOUT_STORAGE_KEY,
  parseAssistantLayout,
  serializeAssistantLayout,
  toggleAssistantLayout,
  withAssistantMode,
  type AssistantLayout,
} from '../services/studio/assistantWindow'
import {
  LEGACY_MIXER_STORAGE_KEY,
  PANEL_LAYOUT_STORAGE_KEY,
  STUDIO_SIDE_TAB_LABELS,
  STUDIO_SIDE_TABS,
  parsePanelLayout,
  serializePanelLayout,
  showSideTab,
  toggleMixer,
  toggleSidePanel,
  type StudioPanelLayout,
  type StudioSideTab,
} from '../services/studio/panelLayout'
import { sessionToNewSong, studioToSongPatch } from '../services/studio/songStudioBridge'
import { createStudioCollabChannel, type RealtimeClientLike } from '../services/studio/studioCollab'
import { listStemSongs } from '../services/stemStore'
import { sectionSpans, type SectionSpan } from '../services/stemTiming'
import { commandShortcuts, displayShortcut, loadKeymap, matchEvent } from '../services/studio/commands'
import { isComputerKeyboardCode } from '../services/studio/computerKeyboard'
import { isTextFieldTarget } from '../services/studio/midiInput'
import { STUDIO_MAX_TITLE } from '../services/studio/session'
import type { CommandContext, Keymap } from '../services/studio/types'
import * as studioCloud from '../services/studio/studioCloud'
import * as studioStore from '../services/studio/studioStore'
import { readStudioPrefs, shouldStopRecordingOnLeave } from '../services/studio/studioPrefs'
import { playlistItemFromSong } from '../services/workspaceSchema'
import type { Playlist, Song } from '../types/hub'
import '../styles/studio.css'

/** Debajo de 768 px se activa el conmutador tactil de 5 superficies moviles. */
const MOBILE_QUERY = '(max-width: 767px)'

function subscribeMobile(listener: () => void): () => void {
  const query = window.matchMedia(MOBILE_QUERY)
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

function useMobileScreen(): boolean {
  return useSyncExternalStore(
    subscribeMobile,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false
  )
}

export type StudioMobileSurface = 'quick' | 'arrange' | 'notes' | 'console' | 'fx'

/** "Ctrl" de los atajos: Cmd en macOS (keymap.ts). */
const PLATFORM: 'mac' | 'other' = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent) ? 'mac' : 'other'
const KEYBOARD_CTX: StudioCommandCtx = { source: 'keyboard' }
/** Atajos que, si el comando no aplica aqui, se dejan al navegador. */
const BROWSER_PASSTHROUGH: ReadonlySet<string> = new Set(['edit.copy', 'edit.cut', 'edit.paste', 'edit.select_all'])

/** Atajo vigente de un comando, para los titulos de los botones. */
function shortcutLabel(registry: StudioRegistry, keymap: Keymap, id: string): string {
  const command = registry.get(id)
  const first = command ? commandShortcuts(command, keymap)[0] : undefined
  return first ? displayShortcut(first, PLATFORM) : 'sin atajo'
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? 'sin fecha' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function sectionsFor(songs: readonly Song[], songId: string | null, bpm: number, beatsPerBar: number): SectionSpan[] {
  const song = songId ? songs.find((s) => s.id === songId) : undefined
  // Las secciones salen de la cancion, pero con el tempo de la SESION: la regla es una sola.
  return song ? sectionSpans({ bpm, beatsPerBar, sections: song.sections }) : []
}

// ---------------------------------------------------------------------------
// Sesion abierta
// ---------------------------------------------------------------------------

/** Iconos del riel del panel lateral, en el orden de la maqueta (Inspector, Dispositivo, IA). */
const SIDE_TAB_ICONS: Readonly<Record<StudioSideTab, React.ComponentType<{ size?: number }>>> = {
  inspector: SlidersHorizontal,
  device: Mic,
  jobs: Sparkles,
}

/** Disposicion de paneles guardada en este navegador (con la clave vieja del mezclador como respaldo). */
function readPanelLayout(): StudioPanelLayout {
  return parsePanelLayout(studioKeymapStorage.getItem(PANEL_LAYOUT_STORAGE_KEY), studioKeymapStorage.getItem(LEGACY_MIXER_STORAGE_KEY))
}

interface WorkspaceProps {
  controller: StudioController
  songs: readonly Song[]
  playlists: readonly Playlist[]
  onClose: () => void
}

const StudioWorkspace: React.FC<WorkspaceProps> = ({ controller, songs, playlists, onClose }) => {
  const { sharing, saveSong, setActivePlaylist, addSongToPlaylist, setActiveSongId } = useHub()
  const snap = useStudio(controller)
  const { session, save, recording } = snap
  const mobile = useMobileScreen()
  const [mobileSurface, setMobileSurface] = useState<StudioMobileSurface>('quick')
  // Consola y panel lateral plegables a un clic (services/studio/panelLayout.ts), recordados aqui.
  const [panels, setPanels] = useState<StudioPanelLayout>(readPanelLayout)
  const [versionsOpen, setVersionsOpen] = useState(false)
  useEffect(() => {
    studioKeymapStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, serializePanelLayout(panels))
  }, [panels])
  const [waveformOpen, setWaveformOpen] = useState(false)
  const [probeOpen, setProbeOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [songBridgeOpen, setSongBridgeOpen] = useState(false)
  const [promoteArtist, setPromoteArtist] = useState('')
  const [promotePlaylistId, setPromotePlaylistId] = useState('')

  const showPanel = useCallback((tab: StudioSideTab) => {
    setVersionsOpen(false)
    setPanels((current) => showSideTab(current, tab))
  }, [])
  const showVersions = useCallback(() => {
    setVersionsOpen(true)
    setPanels((current) => (current.sideOpen ? current : { ...current, sideOpen: true }))
  }, [])
  const toggleSide = useCallback(() => setPanels(toggleSidePanel), [])
  const toggleConsole = useCallback(() => setPanels(toggleMixer), [])
  // El mezclador elige un efecto: se muestra el inspector, que es donde se edita.
  const showInspector = useCallback(() => {
    showPanel('inspector')
    if (mobile) setMobileSurface('fx')
  }, [showPanel, mobile])
  const openWaveform = useCallback(() => {
    // El acceso rapido vive en la barra de la linea de tiempo: con el piano roll abierto se vuelve a ella.
    if (controller.snapshot().editor === 'piano_roll') controller.toggleEditor()
    setWaveformOpen(true)
  }, [controller])
  const openExport = useCallback(() => {
    controller.pause()
    setExportOpen(true)
  }, [controller])

  const selectMobileSurface = useCallback(
    (surface: StudioMobileSurface) => {
      setMobileSurface(surface)
      if (surface === 'arrange' && controller.snapshot().editor === 'piano_roll') {
        controller.toggleEditor()
      } else if (surface === 'notes' && controller.snapshot().editor !== 'piano_roll') {
        controller.toggleEditor()
      } else if (surface === 'console' && !panels.mixerOpen) {
        setPanels((cur) => ({ ...cur, mixerOpen: true }))
      } else if (surface === 'fx' && !panels.sideOpen) {
        setPanels((cur) => ({ ...cur, sideOpen: true }))
      }
    },
    [controller, panels.mixerOpen, panels.sideOpen],
  )

  const recordAllowed = snap.recordBlockReason === null
  const recordHint = snap.recordBlockReason
  const song = session.songId ? songs.find((s) => s.id === session.songId) : undefined

  const sections = useMemo(() => sectionsFor(songs, session.songId, session.bpm, session.beatsPerBar), [songs, session.songId, session.bpm, session.beatsPerBar])
  useEffect(() => {
    controller.setSections(sections)
  }, [controller, sections])
  // El asistente del chat manda la progresion de acordes de la cancion ligada (sin letra).
  useEffect(() => {
    controller.setLinkedSong(song ?? null)
  }, [controller, song])

  // ---- comandos: un solo registro para el teclado, la paleta y el asistente ----
  // Lo que el registro lee de la vista va por un puente que se actualiza en un efecto: el
  // registro se crea una sola vez por controlador.
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const midiFileRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // Ventana del asistente: modo, posicion y tamano se recuerdan en este navegador.
  const [assistLayout, setAssistLayout] = useState<AssistantLayout>(() =>
    parseAssistantLayout(studioKeymapStorage.getItem(ASSISTANT_LAYOUT_STORAGE_KEY), { width: window.innerWidth, height: window.innerHeight })
  )
  useEffect(() => {
    studioKeymapStorage.setItem(ASSISTANT_LAYOUT_STORAGE_KEY, serializeAssistantLayout(assistLayout))
  }, [assistLayout])
  const toggleAssistant = useCallback(() => setAssistLayout(toggleAssistantLayout), [setAssistLayout])
  const openAssistant = useCallback(() => setAssistLayout((layout) => withAssistantMode(layout, 'floating')), [setAssistLayout])

  const [uiBridge] = useState(() => new StudioUiBridge())
  useEffect(() => {
    uiBridge.set({
      recordAllowed: () => recordAllowed,
      recordHint: () => recordHint,
      openPalette: () => setPaletteOpen(true),
      openShortcuts: () => setShortcutsOpen(true),
      openExport,
      pickMidiFile: () => midiFileRef.current?.click(),
      toggleAssistant,
      toggleMixer: toggleConsole,
      toggleSidePanel: toggleSide,
      showPanel: (tab) => (tab === 'versions' ? showVersions() : showPanel(tab)),
      openWaveform,
    })
  }, [uiBridge, recordAllowed, recordHint, openExport, toggleAssistant, toggleConsole, toggleSide, showPanel, showVersions, openWaveform])
  const registry = useMemo(() => createStudioCommandRegistry(controller, uiBridge), [controller, uiBridge])
  const [keymap, setKeymap] = useState<Keymap>(() => loadKeymap(studioKeymapStorage, registry.list()))

  /** Contexto de los atajos: el piano roll si esta abierto, el mezclador si tiene el foco. */
  const commandContext = useCallback((): CommandContext => {
    if (controller.snapshot().editor === 'piano_roll') return 'piano_roll'
    const active = document.activeElement
    if (active instanceof Element && active.closest('.stu-mixer')) return 'mixer'
    return 'timeline'
  }, [controller])

  const runCommand = useCallback(
    (id: string, source: StudioCommandCtx['source']) => {
      registry.run(id, { source }).catch((err: unknown) => controller.notify('error', errorText(err, 'No se pudo ejecutar el comando.')))
    },
    [registry, controller]
  )

  // Atajos de teclado (services/studio/keymap.ts). No se disparan al escribir en un campo, con un
  // dialogo abierto ni con el foco fuera del Estudio.
  useEffect(() => {
    if (probeOpen || exportOpen || paletteOpen || shortcutsOpen || songBridgeOpen) return
    const onKey = (event: KeyboardEvent) => {
      // Ya lo atendio un control propio (lienzo de la linea de tiempo, teclado musical).
      if (event.defaultPrevented) return
      const target = event.target
      const root = rootRef.current
      if (target instanceof Node && target !== document.body && root && !root.contains(target)) return
      if (target instanceof HTMLElement && target.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')) return
      // Tab y Shift+Tab son siempre del navegador (mover el foco), en cualquier elemento y en el
      // body: consumirlos dejaba el foco atrapado en los lienzos (WCAG 2.1.2).
      if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) return
      // Con el teclado musical encendido, A, S, D... son notas (la clase MIDI ya las consume).
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      if (plain && controller.snapshot().midi.keyboard && isComputerKeyboardCode(event.code)) return
      const inText = isTextFieldTarget(target)
      // Escribiendo en el asistente, su atajo con modificador (Alt+A) lo sigue ocultando.
      if (inText && (event.ctrlKey || event.metaKey || event.altKey) && target instanceof Element && target.closest('[data-studio-assistant]')) {
        const toggle = registry.get('view.toggle_assistant')
        if (toggle && matchEvent(event, commandContext(), false, [toggle], keymap, PLATFORM) === toggle.id) {
          event.preventDefault()
          runCommand(toggle.id, 'keyboard')
        }
        return
      }
      if (target instanceof HTMLElement && !inText) {
        // En un control, espacio, Enter y Tab son del control (Tab sigue moviendo el foco). En un
        // deslizador, las flechas lo mueven.
        const control = /^(BUTTON|A|SUMMARY|INPUT)$/.test(target.tagName) || target.getAttribute('role') === 'tab'
        if (control && (event.key === ' ' || event.key === 'Enter' || event.key === 'Tab')) return
        if (target.tagName === 'INPUT' && /^(Arrow|Page)|^(Home|End)$/.test(event.key)) return
      }
      const id = matchEvent(event, commandContext(), inText, registry.list(), keymap, PLATFORM)
      if (!id) return
      const command = registry.get(id)
      if (!command) return
      if (command.isEnabled && !command.isEnabled(KEYBOARD_CTX)) {
        // Deshabilitado: copiar, cortar, pegar y seleccionar todo vuelven al navegador; los demas
        // se consumen igual (Ctrl+D no abre los marcadores a mitad de una toma).
        if (!BROWSER_PASSTHROUGH.has(id)) event.preventDefault()
        return
      }
      event.preventDefault()
      runCommand(id, 'keyboard')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [controller, registry, keymap, commandContext, runCommand, probeOpen, exportOpen, paletteOpen, shortcutsOpen, songBridgeOpen])

  // Cerrar la pestana con una toma en curso la dejaria sin cerrar, y con un guardado pendiente o
  // una subida a la nube en curso se perderia trabajo: el navegador pregunta antes. El estado se
  // lee del controlador en el momento, no de un render (el guardado pendiente dura 700 ms).
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (controller.snapshot().recording || controller.hasUnsavedWork()) {
        controller.flushLocalSave()
        event.preventDefault()
      }
    }
    // Al ocultarse o descargarse la pagina se guarda de inmediato lo que esperaba el temporizador.
    const flush = () => controller.flushLocalSave()
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [controller])

  const openProbe = () => {
    controller.pause()
    void controller.closeInput().then(() => setProbeOpen(true))
  }

  const songSyncPreview = useMemo(() => (song ? studioToSongPatch(song, session) : null), [song, session])

  const handleApplyStudioToSong = () => {
    if (!songSyncPreview || !sharing.activeCanEdit) return
    saveSong(songSyncPreview.updatedSong)
    setSongBridgeOpen(false)
    controller.notify('info', `Ficha de «${songSyncPreview.updatedSong.title}» actualizada con el arreglo del Estudio.`)
  }

  const handleImportFromSong = () => {
    if (!song) return
    controller.syncStructureFromSong(song)
    setSongBridgeOpen(false)
  }

  const handlePromoteFreeDemo = (e: React.FormEvent) => {
    e.preventDefault()
    if (!sharing.activeCanEdit) return
    const created = sessionToNewSong(session, { artist: promoteArtist.trim() })
    saveSong(created)
    if (promotePlaylistId) {
      const targetPl = playlists.find((p) => p.id === promotePlaylistId)
      if (targetPl) setActivePlaylist(targetPl)
      addSongToPlaylist(playlistItemFromSong(created))
    }
    controller.linkSongId(created.id)
    setActiveSongId(created.id)
    setSongBridgeOpen(false)
    controller.notify('info', `Maqueta promovida a canción oficial: «${created.title}».`)
  }

  const activePeers = useMemo(
    () => snap.collaborators.filter((peer) => !peer.sessionId || peer.sessionId === session.id),
    [snap.collaborators, session.id],
  )

  const saveText =
    save.cloud === 'saving'
      ? save.uploading && save.uploading.total > 0
        ? `SUBIENDO AUDIO ${save.uploading.done}/${save.uploading.total}`
        : 'GUARDANDO EN LA NUBE'
      : save.local === 'error'
        ? 'NO SE GUARDÓ EN ESTE EQUIPO'
        : save.local === 'pending'
          ? 'GUARDANDO...'
          : save.dirty
            ? 'GUARDADO EN ESTE EQUIPO'
            : 'GUARDADO EN LA NUBE'
  const cloudTitle = !snap.cloudAvailable
    ? 'Entra con tu cuenta de nube para sincronizar el Estudio con la banda.'
    : !snap.canEditCloud
      ? 'Tu rol (Substitute) es de solo lectura en la nube del Estudio.'
      : 'Sube los audios pendientes y sincroniza la sesión con la banda (Ctrl+S)'
  const missing = snap.engine.missingAssetIds.length
  const effectiveMixerOpen = mobile ? mobileSurface === 'console' : panels.mixerOpen
  const effectiveSideOpen = mobile ? mobileSurface === 'fx' : panels.sideOpen

  return (
    <div
      ref={rootRef}
      className="stu"
      data-console={effectiveMixerOpen ? 'open' : 'closed'}
      data-mobile-surface={mobile ? mobileSurface : undefined}
      data-testid="studio-workspace"
    >
      <header className="stu-bar">
        <button type="button" className="stu-btn" data-tone="ghost" onClick={onClose} disabled={recording} aria-label="Volver a la lista de sesiones" data-testid="studio-back">
          <ArrowLeft size={14} />
          SESIONES
        </button>
        <input
          key={`title-${session.title}`}
          className="stu-field stu-title"
          data-plain="true"
          defaultValue={session.title}
          maxLength={STUDIO_MAX_TITLE}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              event.currentTarget.value = session.title
              event.currentTarget.blur()
            }
          }}
          onBlur={(event) => {
            const title = event.target.value.trim()
            if (title && title !== session.title) controller.updateMeta({ title }, 'Renombrar sesión')
            else event.target.value = session.title
          }}
          aria-label="Título de la sesión"
          data-testid="studio-title"
        />
        <button
          type="button"
          className="stu-btn"
          data-size="small"
          onClick={() => setSongBridgeOpen(true)}
          title={song ? `Sincronizar estructura/acordes con «${song.title}»` : 'Promover maqueta libre a Canción oficial de la librería'}
          data-testid="studio-song-bridge-open"
        >
          <ArrowLeftRight size={12} />
          {song ? song.title.toUpperCase().slice(0, 22) : 'MAQUETA LIBRE'}
        </button>
        {activePeers.length > 0 && (
          <span className="stu-badge" data-tone="ok" title={activePeers.map((p) => `${p.name} (${p.branch})`).join(', ')} data-testid="studio-collab-peers">
            <Users size={11} />
            {activePeers.length === 1 ? activePeers[0].name.slice(0, 14) : `${activePeers.length} EN LÍNEA`}
          </span>
        )}
        <span className="stu-bar-spacer" />
        {(snap.abState !== null || snap.vcs.index.commits.length > 0) && (
          <button
            type="button"
            className="stu-btn"
            data-size="small"
            data-on={snap.abState?.active === 'B'}
            data-accent="warn"
            onClick={() => void controller.toggleAbListening()}
            title="Comparación auditiva instantánea A/B (0 ms) contra la última versión guardada"
            data-testid="studio-ab-quick"
          >
            <Headphones size={12} />
            {snap.abState?.active === 'B' ? 'ESCUCHANDO B' : 'A / B'}
          </button>
        )}
        <button
          type="button"
          className="stu-btn"
          data-size="small"
          data-on={versionsOpen && effectiveSideOpen}
          onClick={() => {
            if (mobile) {
              setVersionsOpen(true)
              selectMobileSurface('fx')
            } else {
              showVersions()
            }
          }}
          title="Ramas y Control de Versiones del Estudio"
          data-testid="studio-versions-open"
        >
          <GitBranch size={12} />
          {snap.vcs.activeBranch.toUpperCase()}
        </button>
        <span className="stu-label" aria-live="polite" data-testid="studio-save-status">
          {saveText}
        </span>
        <button
          type="button"
          className="stu-btn"
          data-tone={save.dirty ? 'primary' : undefined}
          disabled={!snap.cloudAvailable || !snap.canEditCloud || save.cloud === 'saving' || recording}
          onClick={() => void controller.saveToCloud()}
          title={cloudTitle}
          data-testid="studio-save"
        >
          <CloudUpload size={14} />
          GUARDAR
        </button>
        <button
          type="button"
          className="stu-btn"
          data-size="icon"
          data-tone="ghost"
          onClick={() => setPaletteOpen(true)}
          aria-label="Paleta de comandos"
          title={`Paleta de comandos (${shortcutLabel(registry, keymap, 'view.command_palette')})`}
          data-testid="studio-palette-open"
        >
          <Command size={14} />
        </button>
        <button
          type="button"
          className="stu-btn"
          data-size="icon"
          data-tone="ghost"
          onClick={() => setShortcutsOpen(true)}
          aria-label="Atajos de teclado"
          title={`Atajos de teclado (${shortcutLabel(registry, keymap, 'view.shortcuts')})`}
          data-testid="studio-shortcuts-open"
        >
          <Keyboard size={14} />
        </button>
        <button
          type="button"
          className="stu-btn"
          data-on={assistLayout.mode !== 'minimized'}
          aria-pressed={assistLayout.mode !== 'minimized'}
          onClick={toggleAssistant}
          title={`Mostrar u ocultar el asistente (${shortcutLabel(registry, keymap, 'view.toggle_assistant')})`}
          data-testid="studio-assistant-toggle"
        >
          <Sparkles size={14} />
          ASISTENTE
        </button>
        <div className="stu-seg" role="group" aria-label="Paneles">
          <button
            type="button"
            className="stu-btn"
            data-size="icon"
            data-on={panels.mixerOpen}
            aria-pressed={panels.mixerOpen}
            onClick={toggleConsole}
            aria-label="Consola de mezcla"
            title={`Mostrar u ocultar la consola de mezcla (${shortcutLabel(registry, keymap, 'view.toggle_mixer')})`}
            data-testid="studio-console-toggle"
          >
            <PanelBottom size={15} />
          </button>
          <button
            type="button"
            className="stu-btn"
            data-size="icon"
            data-on={panels.sideOpen}
            aria-pressed={panels.sideOpen}
            onClick={toggleSide}
            aria-label="Panel lateral"
            title={`Mostrar u ocultar el panel lateral: inspector, dispositivo e IA (${shortcutLabel(registry, keymap, 'view.toggle_side_panel')})`}
            data-testid="studio-dock-toggle"
          >
            <PanelRight size={15} />
          </button>
        </div>
      </header>

      {!recordAllowed && (
        <div className="stu-notice" data-tone="info" role="status" data-testid="studio-playback-only">
          <span>
            <strong>Modo de solo reproducción y mezcla.</strong> {recordHint} Puedes escuchar, editar, mezclar e importar audio.
          </span>
        </div>
      )}

      {snap.notice && (
        <div className="stu-notice" data-tone={snap.notice.tone} role={snap.notice.tone === 'error' ? 'alert' : 'status'} data-testid="studio-notice">
          <span>{snap.notice.text}</span>
          <button type="button" className="stu-btn" data-size="mini" data-tone="ghost" onClick={() => controller.dismissNotice()} aria-label="Cerrar el aviso">
            <X size={12} />
          </button>
        </div>
      )}

      {save.cloud === 'conflict' && (
        <div className="stu-notice" data-tone="warn" role="alert" data-testid="studio-conflict">
          <span>
            <strong>La nube tiene otra versión de esta sesión.</strong> {save.cloudDetail} Recargar descarta lo que cambiaste aquí; sobrescribir reemplaza lo que hay en la nube.
          </span>
          <div className="stu-notice-actions">
            <button type="button" className="stu-btn" onClick={() => void controller.reloadFromCloud()} data-testid="studio-conflict-reload">
              RECARGAR
            </button>
            <button type="button" className="stu-btn" data-tone="danger" onClick={() => void controller.saveToCloud(true)} data-testid="studio-conflict-overwrite">
              SOBRESCRIBIR
            </button>
            <button type="button" className="stu-btn" data-tone="ghost" onClick={() => controller.dismissCloudError()}>
              AHORA NO
            </button>
          </div>
        </div>
      )}

      {save.cloud === 'error' && (
        <div className="stu-notice" data-tone="error" role="alert" data-testid="studio-cloud-error">
          <span>{save.cloudDetail ?? 'No se pudo guardar en la nube.'} La sesión sigue guardada en este equipo.</span>
          <div className="stu-notice-actions">
            <button type="button" className="stu-btn" onClick={() => void controller.saveToCloud()}>
              REINTENTAR
            </button>
            <button type="button" className="stu-btn" data-size="mini" data-tone="ghost" onClick={() => controller.dismissCloudError()} aria-label="Cerrar el aviso">
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      {missing > 0 && !snap.loading && (
        <div className="stu-notice" data-tone="warn" role="status" data-testid="studio-missing">
          <span>
            {missing === 1 ? 'Falta 1 audio' : `Faltan ${missing} audios`} en este equipo y no se {missing === 1 ? 'pudo' : 'pudieron'} bajar de la nube: sus clips aparecen rayados y no suenan.
          </span>
        </div>
      )}

      {snap.orphanTakes.map((take) => (
        <div key={take.file} className="stu-notice" data-tone="info" role="status" data-testid="studio-orphan">
          <span>
            Hay una toma sin guardar de {take.estimatedDurationS.toFixed(1)} s ({formatWhen(new Date(take.lastModified).toISOString())}). Quedó en disco al cerrarse el navegador o al deshacer.
          </span>
          <div className="stu-notice-actions">
            <button type="button" className="stu-btn" disabled={recording} onClick={() => void controller.recoverOrphan(take.file)}>
              RECUPERAR
            </button>
            <button type="button" className="stu-btn" data-tone="ghost" disabled={recording} onClick={() => void controller.discardOrphan(take.file)}>
              DESCARTAR
            </button>
          </div>
        </div>
      ))}

      <StudioTransport controller={controller} recordAllowed={recordAllowed} recordHint={recordHint} />

      {mobile && (
        <nav className="stu-mobile-nav" aria-label="Superficies móviles del Estudio" data-testid="studio-mobile-nav">
          {(
            [
              ['quick', 'RÁPIDO'],
              ['arrange', 'ARREGLO'],
              ['notes', 'NOTAS'],
              ['console', 'CONSOLA'],
              ['fx', 'MASTER/FX'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="stu-btn"
              data-on={mobileSurface === id}
              aria-pressed={mobileSurface === id}
              onClick={() => selectMobileSurface(id)}
              data-testid={`studio-mobile-surface-${id}`}
            >
              {label}
            </button>
          ))}
        </nav>
      )}

      {mobile && mobileSurface === 'quick' && (
        <StudioMobileQuickSurface
          controller={controller}
          recordAllowed={recordAllowed}
          onOpenExport={openExport}
          onSyncToSong={() => setSongBridgeOpen(true)}
        />
      )}

      <div className="stu-main" data-side={effectiveSideOpen}>
        <div className="stu-main-editor" hidden={mobile && mobileSurface !== 'arrange' && mobileSurface !== 'notes'}>
          <StudioTimeline controller={controller} recordAllowed={recordAllowed} waveformOpen={waveformOpen} onWaveformOpenChange={setWaveformOpen} />
        </div>

        <aside className="stu-side" aria-label="Panel lateral" data-open={effectiveSideOpen} hidden={mobile && mobileSurface !== 'fx'} data-testid="studio-side">
          {/* El panel se oculta sin desmontarse: un trabajo de IA en curso no se pierde. */}
          <div
            className="stu-dock"
            role="tabpanel"
            id="studio-dock-panel"
            aria-labelledby={versionsOpen ? 'studio-tab-versions' : `studio-tab-${panels.sideTab}`}
            hidden={!effectiveSideOpen}
            data-testid="studio-dock"
          >
            <div className="stu-dock-head">
              <span className="stu-dock-title">{versionsOpen ? 'Versiones y Ramas' : STUDIO_SIDE_TAB_LABELS[panels.sideTab]}</span>
              <button
                type="button"
                className="stu-btn"
                data-size="mini"
                data-tone="ghost"
                onClick={toggleSide}
                aria-label="Plegar el panel lateral"
                title={`Plegar el panel lateral (${shortcutLabel(registry, keymap, 'view.toggle_side_panel')})`}
                data-testid="studio-dock-collapse"
              >
                <PanelRightClose size={13} />
              </button>
            </div>
            <div className="stu-dock-body">
              {versionsOpen && <StudioVersionPanel controller={controller} />}
              {!versionsOpen && panels.sideTab === 'device' && <StudioDevicePanel controller={controller} recordAllowed={recordAllowed} recordHint={recordHint} onOpenProbe={openProbe} />}
              {!versionsOpen && panels.sideTab === 'inspector' && <StudioInspector controller={controller} />}
              {/* El panel de IA queda montado al cambiar de pestana, por la misma razon. */}
              <div className="stu-dock-keep" hidden={versionsOpen || panels.sideTab !== 'jobs'}>
                <StudioJobsPanel controller={controller} onOpenAssistant={openAssistant} assistantShortcut={shortcutLabel(registry, keymap, 'view.toggle_assistant')} />
              </div>
            </div>
          </div>
          {/* Riel siempre a la vista: el primer boton pliega o despliega; un clic en un icono abre su panel. */}
          <div className="stu-rail">
            <button
              type="button"
              className="stu-rail-btn"
              data-tone="ghost"
              onClick={toggleSide}
              aria-expanded={effectiveSideOpen}
              aria-controls="studio-dock-panel"
              aria-label={effectiveSideOpen ? 'Plegar el panel lateral' : 'Desplegar el panel lateral'}
              title={`${effectiveSideOpen ? 'Plegar' : 'Desplegar'} el panel lateral (${shortcutLabel(registry, keymap, 'view.toggle_side_panel')})`}
              data-testid="studio-side-toggle"
            >
              {effectiveSideOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
            </button>
            <span className="stu-rail-sep" aria-hidden="true" />
            <div className="stu-rail-tabs" role="tablist" aria-orientation="vertical" aria-label="Paneles">
              {STUDIO_SIDE_TABS.map((tab) => {
                const Icon = SIDE_TAB_ICONS[tab]
                const selected = !versionsOpen && panels.sideTab === tab
                return (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    id={`studio-tab-${tab}`}
                    aria-selected={selected}
                    aria-controls="studio-dock-panel"
                    className="stu-rail-btn"
                    data-open={effectiveSideOpen && selected}
                    onClick={() => showPanel(tab)}
                    aria-label={STUDIO_SIDE_TAB_LABELS[tab]}
                    title={STUDIO_SIDE_TAB_LABELS[tab]}
                    data-testid={`studio-tab-${tab}`}
                  >
                    <Icon size={16} />
                  </button>
                )
              })}
              <button
                type="button"
                role="tab"
                id="studio-tab-versions"
                aria-selected={versionsOpen}
                aria-controls="studio-dock-panel"
                className="stu-rail-btn"
                data-open={effectiveSideOpen && versionsOpen}
                onClick={showVersions}
                aria-label="Versiones y Ramas"
                title="Versiones y Ramas (snapshots y comparación A/B)"
                data-testid="studio-tab-versions"
              >
                <GitBranch size={16} />
              </button>
            </div>
          </div>
        </aside>

        {/* Montado siempre (tambien minimizado): una respuesta del asistente en camino no se pierde. */}
        <StudioAssistant
          controller={controller}
          registry={registry}
          commandContext={commandContext}
          layout={assistLayout}
          onLayout={setAssistLayout}
          shortcut={shortcutLabel(registry, keymap, 'view.toggle_assistant')}
        />
      </div>

      <div hidden={mobile && mobileSurface !== 'console'}>
        <StudioMixer controller={controller} onEditFx={showInspector} onExport={openExport} open={effectiveMixerOpen} onToggle={toggleConsole} toggleShortcut={shortcutLabel(registry, keymap, 'view.toggle_mixer')} />
      </div>

      <input
        ref={midiFileRef}
        type="file"
        accept=".mid,.midi,audio/midi,audio/x-midi"
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void controller.importMidiFile(file)
        }}
        data-testid="studio-midi-file"
      />

      {paletteOpen && (
        <StudioCommandPalette
          registry={registry}
          keymap={keymap}
          platform={PLATFORM}
          ctx={{ source: 'palette' }}
          onRun={(id) => {
            setPaletteOpen(false)
            // Despues de cerrar: el foco ya volvio al Estudio y un dialogo nuevo puede abrirse.
            setTimeout(() => runCommand(id, 'palette'), 0)
          }}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {shortcutsOpen && <StudioShortcuts registry={registry} keymap={keymap} platform={PLATFORM} onChange={setKeymap} onClose={() => setShortcutsOpen(false)} />}

      {exportOpen && <StudioExportDialog controller={controller} song={song ? { id: song.id, title: song.title } : null} onClose={() => setExportOpen(false)} />}

      {songBridgeOpen && (
        <HubModal
          title={song ? 'PUENTE ESTUDIO <-> CANCIÓN' : 'PROMOVER MAQUETA A CANCIÓN'}
          onClose={() => setSongBridgeOpen(false)}
          maxWidth="540px"
          testId="studio-song-bridge-modal"
        >
          <div className="stu" style={{ padding: 0 }}>
            {song && songSyncPreview ? (
              <>
                <div className="stu-section">
                  <span className="stu-label">Sincronizar hacia Librería ({song.title})</span>
                  <p className="stu-help">
                    Envía tempo, compás, tonalidad, marcadores de sección y acordes del Estudio a la ficha oficial de la canción (preservando letras existentes).
                  </p>
                  <div className="stu-result">
                    <strong>VISTA PREVIA DE CAMBIOS</strong>
                    <p>{songSyncPreview.diff.summary}</p>
                  </div>
                  <div className="stu-actions" data-align="end">
                    <button
                      type="button"
                      className="stu-btn"
                      data-tone="primary"
                      disabled={!sharing.activeCanEdit || !songSyncPreview.diff.changed}
                      onClick={handleApplyStudioToSong}
                      data-testid="studio-bridge-push-song"
                    >
                      <Check size={13} />
                      ACTUALIZAR FICHA DE CANCIÓN
                    </button>
                  </div>
                  {!sharing.activeCanEdit && (
                    <p className="stu-help">Solo Owner o Director Musical pueden sobrescribir la ficha oficial del repertorio.</p>
                  )}
                </div>
                <div className="stu-section">
                  <span className="stu-label">Traer estructura desde Librería al Estudio</span>
                  <p className="stu-help">
                    Importa las {song.sections.length} secciones y acordes ChordPro actuales de «{song.title}» como marcadores y pista armónica en esta sesión (con opción de Deshacer).
                  </p>
                  <div className="stu-actions" data-align="end">
                    <button type="button" className="stu-btn" onClick={handleImportFromSong} data-testid="studio-bridge-pull-song">
                      <ArrowLeftRight size={13} />
                      IMPORTAR DESDE CANCIÓN
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <form className="stu-section" onSubmit={handlePromoteFreeDemo}>
                <span className="stu-label">Promover Maqueta Libre al Repertorio</span>
                <p className="stu-help">
                  Crea una canción oficial en la Librería heredando título ({session.title}), {session.bpm} BPM, tonalidad ({session.key || 'C'}), marcadores como secciones y acordes como ChordPro.
                </p>
                <label className="stu-form-row">
                  <span className="stu-label">Artista / Autor (opcional)</span>
                  <input
                    className="stu-field"
                    value={promoteArtist}
                    onChange={(e) => setPromoteArtist(e.target.value)}
                    placeholder="Nombre de la banda o compositor"
                  />
                </label>
                {playlists.length > 0 && (
                  <label className="stu-form-row">
                    <span className="stu-label">Agregar también a Setlist (opcional)</span>
                    <select className="stu-field" value={promotePlaylistId} onChange={(e) => setPromotePlaylistId(e.target.value)}>
                      <option value="">No agregar a ningún setlist por ahora</option>
                      {playlists.map((pl) => (
                        <option key={pl.id} value={pl.id}>
                          {pl.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="stu-actions" data-align="end">
                  <button type="button" className="stu-btn" data-tone="ghost" onClick={() => setSongBridgeOpen(false)}>
                    CANCELAR
                  </button>
                  <button type="submit" className="stu-btn" data-tone="primary" disabled={!sharing.activeCanEdit} data-testid="studio-bridge-promote">
                    <Music2 size={13} />
                    CREAR CANCIÓN OFICIAL
                  </button>
                </div>
                {!sharing.activeCanEdit && (
                  <p className="stu-help">Solo Owner o Director Musical pueden crear canciones oficiales en una banda compartida.</p>
                )}
              </form>
            )}
          </div>
        </HubModal>
      )}

      {probeOpen && (
        <HubModal title="PRUEBA DE INTERFAZ" onClose={() => setProbeOpen(false)} maxWidth="920px" testId="studio-probe-modal">
          <div style={{ padding: 'clamp(12px, 3vw, 20px)', overflowY: 'auto', minHeight: 0 }}>
            <StudioDeviceProbe />
          </div>
        </HubModal>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Lista de sesiones
// ---------------------------------------------------------------------------

interface HomeProps {
  band: string
  bandName: string
  cloud: CloudTarget | null
  canCollaborateCloud: boolean
  canDeleteCloud: boolean
  actor: { userId: string; name: string; role: string }
  songs: readonly Song[]
  playlists: readonly Playlist[]
}

/** Sesiones de una banda. Se monta con `key` = banda: al cambiar de banda arranca limpio. */
const StudioHome: React.FC<HomeProps> = ({ band, bandName, cloud, canCollaborateCloud, canDeleteCloud, actor, songs, playlists }) => {
  // El controlador es del audio global: salir de la pestana no cierra la sesion ni corta el audio.
  // Al volver se retoma la sesion abierta de esta banda (misma clave que el `key` de StudioHome).
  const audio = useGlobalAudioEngine()
  const { activeBand, activeSongId, setActiveSongId } = useHub()
  const audioTag = `${activeBand?.id ?? 'none'}:${band}`
  const [controller, setController] = useState<StudioController | null>(() => audio.adoptStudio(audioTag))
  const controllerRef = useRef<StudioController | null>(controller)
  const [entries, setEntries] = useState<SessionEntry[] | null>(null)
  const [cloudError, setCloudError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [backend, setBackend] = useState<'opfs' | 'indexeddb' | 'none' | null>(null)
  const [stemSongIds, setStemSongIds] = useState<ReadonlySet<string>>(new Set())
  // Formulario de sesion nueva (preselecciona la cancion activa del Universo Transversal si existe)
  const [title, setTitle] = useState('')
  const [customSongChoice, setCustomSongChoice] = useState<string | null>(null)
  const [withStems, setWithStems] = useState(true)
  const [creating, setCreating] = useState(false)

  const songId =
    customSongChoice !== null
      ? customSongChoice
      : activeSongId && songs.some((s) => s.id === activeSongId)
        ? activeSongId
        : ''

  const sortedSongs = useMemo(() => [...songs].sort((a, b) => a.title.localeCompare(b.title)), [songs])
  const pickedSong = songId ? songs.find((s) => s.id === songId) : undefined

  const refresh = useCallback(
    () =>
      listSessionEntries(band, cloud).then(
        (result) => {
          setEntries(result.entries)
          setCloudError(result.cloudError)
        },
        (err: unknown) => {
          setEntries([])
          setError(errorText(err, 'No se pudieron leer las sesiones de este equipo.'))
        }
      ),
    [band, cloud]
  )

  useEffect(() => {
    void refresh()
    void studioStore.storageBackend().then(setBackend)
    void listStemSongs()
      .then((records) => setStemSongIds(new Set(records.filter((record) => record.tracks.length > 0).map((record) => record.songId))))
      .catch(() => undefined)
  }, [refresh])

  // Canal Realtime del catalogo de sesiones: cuando otro integrante crea o guarda una sesion en la
  // banda compartida, la lista de StudioHome se refresca sola en tiempo real.
  const homeCollabRef = useRef<ReturnType<typeof createStudioCollabChannel> | null>(null)
  useEffect(() => {
    if (controller || !cloud || band === 'me') return
    const sb = getSupabaseClient() as unknown as RealtimeClientLike | null
    const handle = createStudioCollabChannel({
      client: sb,
      bandId: band,
      initialPresence: {
        userId: actor.userId,
        name: actor.name,
        role: actor.role,
        sessionId: null,
        branch: 'main',
        selectedTrackId: null,
      },
      onEvent: (ev) => {
        if (ev.type === 'session_catalog_changed' || ev.type === 'session_saved') {
          void refresh()
        }
      },
    })
    homeCollabRef.current = handle
    return () => {
      handle.dispose()
      homeCollabRef.current = null
    }
  }, [controller, cloud, band, actor.userId, actor.name, actor.role, refresh])

  // Salir de la pestana ya no cierra nada: motor, grabador y contexto de audio los libera el audio
  // global (context/GlobalAudioContext.tsx) al cerrar la sesion, al cambiar de banda o de usuario.
  // Una toma en curso sigue grabando salvo que AJUSTES > ESTUDIO pida detenerla al salir
  // (services/studio/studioPrefs.ts); detenerla deja lo grabado como clip, igual que REC.
  useEffect(
    () => () => {
      const current = controllerRef.current
      if (current && shouldStopRecordingOnLeave(readStudioPrefs(), current.snapshot().recording)) void current.stopRecording()
    },
    []
  )

  const launch = (opened: OpenedSession, importStemsOf: string | null) => {
    if (opened.session.songId) {
      setActiveSongId(opened.session.songId)
    }
    const sb = getSupabaseClient() as unknown as RealtimeClientLike | null
    const next = new StudioController({
      session: opened.session,
      band,
      etag: opened.etag,
      dirty: opened.dirty,
      cloud,
      canEditCloud: canCollaborateCloud,
      sections: sectionsFor(songs, opened.session.songId, opened.session.bpm, opened.session.beatsPerBar),
      actor,
      collabClient: sb,
    })
    controllerRef.current = next
    setController(next)
    // El audio global pasa a ser el dueno (cierra la sesion anterior si habia otra abierta).
    audio.openStudio(next, audioTag)
    void next.start().then(() => {
      if (importStemsOf) void next.importSongStems(importStemsOf)
    })
  }

  const closeSession = () => {
    const current = controllerRef.current
    controllerRef.current = null
    setController(null)
    setEntries(null)
    // Cerrar explicitamente libera el motor (y guarda lo pendiente) a traves del audio global.
    void (current ? audio.closeStudio() : Promise.resolve()).then(refresh)
  }

  const openEntry = async (entry: SessionEntry) => {
    if (busyId) return
    setBusyId(entry.id)
    setError(null)
    try {
      launch(await openSessionEntry(entry, band, cloud), null)
    } catch (err) {
      setError(errorText(err, 'No se pudo abrir la sesión.'))
    } finally {
      setBusyId(null)
    }
  }

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    if (creating) return
    setCreating(true)
    setError(null)
    try {
      const name = title.trim() || (pickedSong ? `${pickedSong.title} - maqueta` : 'Maqueta sin título')
      const opened = await createSession({
        title: name.slice(0, STUDIO_MAX_TITLE),
        band,
        song: pickedSong ? { id: pickedSong.id, bpm: pickedSong.bpm, beatsPerBar: pickedSong.beatsPerBar, key: pickedSong.key ?? '' } : null,
        fullSong: pickedSong ?? null,
        updatedBy: actor.userId,
        cloud,
        canEditCloud: canCollaborateCloud,
      })
      homeCollabRef.current?.broadcast({
        type: 'session_catalog_changed',
        sessionId: opened.session.id,
        senderId: actor.userId,
        title: opened.session.title,
      })
      setTitle('')
      launch(opened, pickedSong && withStems && stemSongIds.has(pickedSong.id) ? pickedSong.id : null)
    } catch (err) {
      setError(errorText(err, 'No se pudo crear la sesión.'))
    } finally {
      setCreating(false)
    }
  }

  const rename = async (entry: SessionEntry, value: string) => {
    const next = value.trim().slice(0, STUDIO_MAX_TITLE)
    setRenamingId(null)
    if (!next || next === entry.title) return
    setBusyId(entry.id)
    try {
      await renameSessionEntry(entry, next, band, cloud)
      await refresh()
    } catch (err) {
      setError(errorText(err, 'No se pudo renombrar la sesión.'))
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (entry: SessionEntry, fromCloud: boolean) => {
    setDeletingId(null)
    setBusyId(entry.id)
    setError(null)
    try {
      if (fromCloud && cloud && entry.cloud && canDeleteCloud) await studioCloud.deleteSession(cloud, entry.id)
      if (entry.local) await studioStore.deleteSession(entry.id)
      await refresh()
    } catch (err) {
      setError(errorText(err, 'No se pudo borrar la sesión.'))
      await refresh()
    } finally {
      setBusyId(null)
    }
  }

  if (controller) return <StudioWorkspace controller={controller} songs={songs} playlists={playlists} onClose={closeSession} />

  if (backend === 'none') {
    return (
      <div className="stu" data-testid="studio-home">
        <div className="stu-notice" data-tone="error" role="alert">
          <span>Este navegador no permite guardar archivos localmente (ni OPFS ni IndexedDB), así que el Estudio no puede abrir sesiones aquí. Usa Chrome o Edge fuera del modo incógnito.</span>
        </div>
      </div>
    )
  }

  return (
    <div className="stu" data-testid="studio-home">
      <header className="stu-home-head">
        <div>
          <span className="stu-label">Estudio Colaborativo · {bandName}</span>
          <h2>Sesiones</h2>
        </div>
        <button
          type="button"
          className="stu-btn"
          disabled={entries === null}
          onClick={() => {
            setEntries(null)
            void refresh()
          }}
          data-testid="studio-refresh"
        >
          <RefreshCw size={13} />
          ACTUALIZAR
        </button>
      </header>

      {error && (
        <div className="stu-notice" data-tone="error" role="alert" data-testid="studio-home-error">
          <span>{error}</span>
          <button type="button" className="stu-btn" data-size="mini" data-tone="ghost" onClick={() => setError(null)} aria-label="Cerrar el aviso">
            <X size={12} />
          </button>
        </div>
      )}
      {cloudError && (
        <div className="stu-notice" data-tone="warn" role="status">
          <span>{cloudError} Se muestran solo las sesiones de este equipo.</span>
        </div>
      )}
      {!cloud && (
        <div className="stu-notice" data-tone="info" role="status">
          <span>Sin sesión de nube: las sesiones del Estudio quedan solo en este navegador. Entra con tu cuenta de nube para compartirlas en tiempo real con la banda.</span>
        </div>
      )}

      <div className="stu-home">
        <section aria-label="Sesiones guardadas" style={{ minWidth: 0 }}>
          {entries === null ? (
            <p className="stu-help" data-testid="studio-list-loading">
              Leyendo sesiones...
            </p>
          ) : entries.length === 0 ? (
            <div className="stu-slot" data-testid="studio-list-empty">
              <strong style={{ color: 'var(--stu-text)' }}>Todavía no hay sesiones</strong>
              <span>Crea una maqueta libre o parte de una canción de la librería: hereda su tempo, compás, tonalidad, secciones y acordes, y se comparte al instante con la banda.</span>
            </div>
          ) : (
            <ul className="stu-list" data-testid="studio-list">
              {entries.map((entry) => {
                const entrySong = entry.songId ? songs.find((s) => s.id === entry.songId) : undefined
                const busy = busyId === entry.id
                return (
                  <li key={entry.id} data-testid={`studio-session-${entry.id}`}>
                    {deletingId === entry.id ? (
                      <div className="stu-item" role="alertdialog" aria-label={`Borrar ${entry.title}`}>
                        <span style={{ flex: '1 1 auto', minWidth: 0, fontSize: '13px' }}>
                          ¿Borrar <strong>{entry.title}</strong> con sus audios? No se puede deshacer.
                        </span>
                        <div className="stu-notice-actions">
                          {entry.local && (
                            <button type="button" className="stu-btn" data-tone="danger" onClick={() => void remove(entry, false)} data-testid="studio-delete-local">
                              DE ESTE EQUIPO
                            </button>
                          )}
                          {entry.cloud && cloud && canDeleteCloud && (
                            <button type="button" className="stu-btn" data-tone="danger" onClick={() => void remove(entry, true)} data-testid="studio-delete-cloud">
                              {entry.local ? 'DEL EQUIPO Y LA NUBE' : 'DE LA NUBE'}
                            </button>
                          )}
                          <button type="button" className="stu-btn" autoFocus onClick={() => setDeletingId(null)}>
                            CANCELAR
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="stu-item">
                        {renamingId === entry.id ? (
                          <form
                            style={{ flex: '1 1 auto', display: 'flex', gap: '6px', minWidth: 0 }}
                            onSubmit={(event) => {
                              event.preventDefault()
                              const input = event.currentTarget.elements.namedItem('title')
                              void rename(entry, input instanceof HTMLInputElement ? input.value : entry.title)
                            }}
                          >
                            <input
                              name="title"
                              className="stu-field"
                              style={{ flex: '1 1 auto', width: 0 }}
                              defaultValue={entry.title}
                              maxLength={STUDIO_MAX_TITLE}
                              autoFocus
                              onKeyDown={(event) => {
                                if (event.key === 'Escape') setRenamingId(null)
                              }}
                              aria-label="Nuevo título de la sesión"
                            />
                            <button type="submit" className="stu-btn" data-size="icon" aria-label="Guardar el título">
                              <Check size={14} />
                            </button>
                            <button type="button" className="stu-btn" data-size="icon" data-tone="ghost" onClick={() => setRenamingId(null)} aria-label="Cancelar">
                              <X size={14} />
                            </button>
                          </form>
                        ) : (
                          <button type="button" className="stu-row" disabled={busyId !== null} onClick={() => void openEntry(entry)} data-testid="studio-open">
                            <span className="stu-row-title">{busy ? `Abriendo ${entry.title}...` : entry.title}</span>
                            <span className="stu-row-meta">
                              <span>{entrySong ? entrySong.title : entry.songId ? 'Canción que ya no está en la librería' : 'Maqueta libre'}</span>
                              <span>{formatWhen(entry.updatedAt)}</span>
                              {entry.local && <span className="stu-badge">EQUIPO</span>}
                              {entry.cloud && (
                                <span className="stu-badge" data-tone="sel">
                                  NUBE
                                </span>
                              )}
                              {entry.local?.dirty && (
                                <span className="stu-badge" data-tone="warn">
                                  SIN SUBIR
                                </span>
                              )}
                            </span>
                          </button>
                        )}
                        {renamingId !== entry.id && (
                          <>
                            <button type="button" className="stu-btn" data-size="icon" data-tone="ghost" disabled={busyId !== null} onClick={() => setRenamingId(entry.id)} aria-label={`Renombrar ${entry.title}`} title="Renombrar">
                              <Pencil size={14} />
                            </button>
                            <button
                              type="button"
                              className="stu-btn"
                              data-size="icon"
                              data-tone="ghost"
                              disabled={busyId !== null || (!entry.local && !(cloud && canDeleteCloud))}
                              onClick={() => setDeletingId(entry.id)}
                              aria-label={`Borrar ${entry.title}`}
                              title="Borrar"
                              data-testid="studio-delete"
                            >
                              <Trash2 size={14} />
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {cloud && canDeleteCloud && <StudioCloudCleanup cloud={cloud} />}
        </section>

        <form className="stu-card" onSubmit={(event) => void create(event)} aria-label="Sesión nueva" data-testid="studio-new">
          <span className="stu-label">Sesión nueva</span>
          <label className="stu-form-row">
            <span className="stu-label">Punto de partida</span>
            <select className="stu-field" value={songId} onChange={(event) => setCustomSongChoice(event.target.value)} data-testid="studio-new-song">
              <option value="">Maqueta libre (120 BPM, 4/4)</option>
              {sortedSongs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
          {pickedSong && (
            <dl className="stu-kv" data-testid="studio-new-inherit">
              <dt>Tempo</dt>
              <dd>{pickedSong.bpm} BPM</dd>
              <dt>Compás</dt>
              <dd>
                {pickedSong.beatsPerBar}/{pickedSong.beatUnit}
              </dd>
              <dt>Tonalidad</dt>
              <dd>{pickedSong.key || 'sin definir'}</dd>
              <dt>Secciones</dt>
              <dd>{pickedSong.sections.length}</dd>
            </dl>
          )}
          {pickedSong &&
            (stemSongIds.has(pickedSong.id) ? (
              <label className="stu-check">
                <input type="checkbox" checked={withStems} onChange={(event) => setWithStems(event.target.checked)} data-testid="studio-new-stems" />
                <span>Importar los stems de esta canción guardados en este equipo, uno por pista, alineados al compás 1.</span>
              </label>
            ) : (
              <p className="stu-help">Esta canción no tiene stems en este equipo. Podrás arrastrar audio o grabar directo en la sesión.</p>
            ))}
          <label className="stu-form-row">
            <span className="stu-label">Título</span>
            <input
              className="stu-field"
              value={title}
              maxLength={STUDIO_MAX_TITLE}
              placeholder={pickedSong ? `${pickedSong.title} - maqueta` : 'Maqueta sin título'}
              onChange={(event) => setTitle(event.target.value)}
              data-testid="studio-new-title"
            />
          </label>
          <button type="submit" className="stu-btn" data-tone="primary" disabled={creating || backend === null} data-testid="studio-create">
            <Plus size={14} />
            {creating ? 'CREANDO...' : 'CREAR SESIÓN'}
          </button>
          <p className="stu-help">
            Se sube automáticamente a la nube de la banda si tienes cuenta activa. {backend === 'indexeddb' ? 'Modo móvil / memoria: soporta grabación de micrófono hasta 3 min.' : ''}
          </p>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Vista
// ---------------------------------------------------------------------------

/**
 * Pestana ESTUDIO del Hub (docs/PLAN_ESTUDIO_BANDAIT.md). Solo se monta con el interruptor
 * `studioEnabled()` (App.tsx). Lista las sesiones de la banda activa (este equipo y la nube) y
 * abre una en el espacio de trabajo: transporte, linea de tiempo y paneles.
 */
export const StudioHubView: React.FC = () => {
  const { songs, playlists, sharing, activeBand, activeBandRole, user } = useHub()
  const band = cloudBandKey(activeBand?.id, sharing.activeShared)
  const cloudEnabled = sharing.cloudSignedIn && !!activeBand
  const cloud = useMemo(() => (cloudEnabled ? stemCloudTarget(band) : null), [cloudEnabled, band])
  const actor = useMemo(
    () => ({
      userId: user?.id ?? 'local',
      name: user?.name ?? 'Integrante',
      role: activeBandRole ?? 'Musician',
    }),
    [user?.id, user?.name, activeBandRole],
  )
  // La clave incluye la banda del workspace: dos bandas personales comparten 'me' en la nube.
  return (
    <StudioHome
      key={`${activeBand?.id ?? 'none'}:${band}`}
      band={band}
      bandName={activeBand?.name ?? 'Sin banda'}
      cloud={cloud}
      canCollaborateCloud={sharing.activeCanCollaborateStudio}
      canDeleteCloud={sharing.activeCanEdit}
      actor={actor}
      songs={songs}
      playlists={playlists}
    />
  )
}
