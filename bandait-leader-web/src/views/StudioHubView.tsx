import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowLeft, Check, CloudUpload, Command, Keyboard, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { useHub } from '../context/hubContextCore'
import { HubModal } from '../components/HubModal'
import { StudioDevicePanel } from '../components/studio/StudioDevicePanel'
import { StudioDeviceProbe } from '../components/studio/StudioDeviceProbe'
import { StudioCommandPalette } from '../components/studio/StudioCommandPalette'
import { createStudioCommandRegistry, StudioUiBridge, studioKeymapStorage, type StudioCommandCtx, type StudioRegistry } from '../components/studio/studioCommandHandlers'
import { StudioExportDialog } from '../components/studio/StudioExportDialog'
import { StudioShortcuts } from '../components/studio/StudioShortcuts'
import { StudioInspector } from '../components/studio/StudioInspector'
import { StudioJobsPanel } from '../components/studio/StudioJobsPanel'
import { StudioMixer } from '../components/studio/StudioMixer'
import { StudioTimeline } from '../components/studio/StudioTimeline'
import { StudioTransport } from '../components/studio/StudioTransport'
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
import { listStemSongs } from '../services/stemStore'
import { sectionSpans, type SectionSpan } from '../services/stemTiming'
import { commandShortcuts, displayShortcut, loadKeymap, matchEvent } from '../services/studio/commands'
import { isComputerKeyboardCode } from '../services/studio/computerKeyboard'
import { isTextFieldTarget } from '../services/studio/midiInput'
import { STUDIO_MAX_TITLE } from '../services/studio/session'
import type { CommandContext, Keymap } from '../services/studio/types'
import * as studioCloud from '../services/studio/studioCloud'
import * as studioStore from '../services/studio/studioStore'
import type { Song } from '../types/hub'
import '../styles/studio.css'

/** Ancho minimo para grabar: por debajo, el Estudio queda en solo reproduccion y mezcla. */
const WIDE_QUERY = '(min-width: 1024px)'
const NARROW_HINT = 'La grabación necesita una ventana de al menos 1024 px de ancho.'

function subscribeWide(listener: () => void): () => void {
  const query = window.matchMedia(WIDE_QUERY)
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

function useWideScreen(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => true
  )
}

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

type DockTab = 'device' | 'inspector' | 'jobs'

const DOCK_TABS: readonly { id: DockTab; label: string }[] = [
  { id: 'device', label: 'DISPOSITIVO' },
  { id: 'inspector', label: 'INSPECTOR' },
  { id: 'jobs', label: 'IA' },
]

interface WorkspaceProps {
  controller: StudioController
  songs: readonly Song[]
  onClose: () => void
}

const StudioWorkspace: React.FC<WorkspaceProps> = ({ controller, songs, onClose }) => {
  const snap = useStudio(controller)
  const { session, save, recording } = snap
  const wide = useWideScreen()
  const [dockOpen, setDockOpen] = useState(true)
  const [dockTab, setDockTab] = useState<DockTab>('device')
  const [probeOpen, setProbeOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)

  // El mezclador elige un efecto: se muestra el inspector, que es donde se edita.
  const showInspector = useCallback(() => {
    setDockOpen(true)
    setDockTab('inspector')
  }, [])
  const openExport = useCallback(() => {
    controller.pause()
    setExportOpen(true)
  }, [controller])

  const recordAllowed = wide && snap.recordBlockReason === null
  const recordHint = !wide ? NARROW_HINT : snap.recordBlockReason
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
  const [uiBridge] = useState(() => new StudioUiBridge())
  useEffect(() => {
    uiBridge.set({
      recordAllowed: () => recordAllowed,
      recordHint: () => recordHint,
      openPalette: () => setPaletteOpen(true),
      openShortcuts: () => setShortcutsOpen(true),
      openExport,
      pickMidiFile: () => midiFileRef.current?.click(),
    })
  }, [uiBridge, recordAllowed, recordHint, openExport])
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
    if (probeOpen || exportOpen || paletteOpen || shortcutsOpen) return
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
  }, [controller, registry, keymap, commandContext, runCommand, probeOpen, exportOpen, paletteOpen, shortcutsOpen])

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
    ? 'Entra con tu cuenta de nube para guardar el Estudio en la nube.'
    : !snap.canEditCloud
      ? 'Solo el Owner o el Director musical pueden guardar en la nube.'
      : 'Sube los audios que falten y el documento de la sesión (Ctrl+S)'
  const missing = snap.engine.missingAssetIds.length

  return (
    <div ref={rootRef} className="stu" data-testid="studio-workspace">
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
        <span className="stu-badge" title={song ? `Canción: ${song.title}` : 'Sesión sin canción'}>
          {song ? song.title.toUpperCase().slice(0, 28) : 'MAQUETA LIBRE'}
        </span>
        <span className="stu-bar-spacer" />
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
        <button type="button" className="stu-btn" data-on={dockOpen} aria-pressed={dockOpen} onClick={() => setDockOpen((value) => !value)} title="Mostrar u ocultar los paneles laterales" data-testid="studio-dock-toggle">
          PANELES
        </button>
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

      <div className="stu-main" data-dock={dockOpen}>
        <StudioTimeline controller={controller} recordAllowed={recordAllowed} />

        {/* El panel lateral se oculta sin desmontarse: un trabajo de IA en curso no se pierde. */}
        <aside className="stu-dock" aria-label="Paneles del Estudio" hidden={!dockOpen}>
            <div className="stu-tabs" role="tablist" aria-label="Paneles">
              {DOCK_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  id={`studio-tab-${tab.id}`}
                  aria-selected={dockTab === tab.id}
                  aria-controls="studio-dock-panel"
                  className="stu-tab"
                  onClick={() => setDockTab(tab.id)}
                  data-testid={`studio-tab-${tab.id}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="stu-dock-body" role="tabpanel" id="studio-dock-panel" aria-labelledby={`studio-tab-${dockTab}`}>
              {dockTab === 'device' && <StudioDevicePanel controller={controller} recordAllowed={recordAllowed} recordHint={recordHint} onOpenProbe={openProbe} />}
              {dockTab === 'inspector' && <StudioInspector controller={controller} />}
              {/* El panel de IA queda montado al cambiar de pestana, por la misma razon. */}
              <div className="stu-dock-keep" hidden={dockTab !== 'jobs'}>
                <StudioJobsPanel controller={controller} registry={registry} commandContext={commandContext} />
              </div>
            </div>
          </aside>
      </div>

      <StudioMixer controller={controller} onEditFx={showInspector} onExport={openExport} />

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
  canEditCloud: boolean
  songs: readonly Song[]
}

/** Sesiones de una banda. Se monta con `key` = banda: al cambiar de banda arranca limpio. */
const StudioHome: React.FC<HomeProps> = ({ band, bandName, cloud, canEditCloud, songs }) => {
  const [controller, setController] = useState<StudioController | null>(null)
  const controllerRef = useRef<StudioController | null>(null)
  const [entries, setEntries] = useState<SessionEntry[] | null>(null)
  const [cloudError, setCloudError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [backend, setBackend] = useState<'opfs' | 'indexeddb' | 'none' | null>(null)
  const [stemSongIds, setStemSongIds] = useState<ReadonlySet<string>>(new Set())
  // Formulario de sesion nueva
  const [title, setTitle] = useState('')
  const [songId, setSongId] = useState('')
  const [withStems, setWithStems] = useState(true)
  const [creating, setCreating] = useState(false)

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

  // Al salir de la pestana (o cambiar de banda) se cierran motor, grabador y contexto de audio.
  // El cierre va en un temporizador que el siguiente montaje cancela: con StrictMode o con la
  // recarga en caliente de Vite el efecto se limpia y se vuelve a montar sin que la vista se vaya.
  const disposeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (disposeTimer.current !== null) clearTimeout(disposeTimer.current)
    disposeTimer.current = null
    return () => {
      disposeTimer.current = setTimeout(() => {
        void controllerRef.current?.dispose()
        controllerRef.current = null
      }, 0)
    }
  }, [])

  const launch = (opened: OpenedSession, importStemsOf: string | null) => {
    const next = new StudioController({
      session: opened.session,
      band,
      etag: opened.etag,
      dirty: opened.dirty,
      cloud,
      canEditCloud,
      sections: sectionsFor(songs, opened.session.songId, opened.session.bpm, opened.session.beatsPerBar),
    })
    controllerRef.current = next
    setController(next)
    void next.start().then(() => {
      if (importStemsOf) void next.importSongStems(importStemsOf)
    })
  }

  const closeSession = () => {
    const current = controllerRef.current
    controllerRef.current = null
    setController(null)
    setEntries(null)
    void (current ? current.dispose() : Promise.resolve()).then(refresh)
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
        updatedBy: null,
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
      if (fromCloud && cloud && entry.cloud) await studioCloud.deleteSession(cloud, entry.id)
      if (entry.local) await studioStore.deleteSession(entry.id)
      await refresh()
    } catch (err) {
      setError(errorText(err, 'No se pudo borrar la sesión.'))
      await refresh()
    } finally {
      setBusyId(null)
    }
  }

  if (controller) return <StudioWorkspace controller={controller} songs={songs} onClose={closeSession} />

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
          <span className="stu-label">Estudio · {bandName}</span>
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
          <span>Sin sesión de nube: las sesiones del Estudio quedan solo en este navegador. Entra con tu cuenta de nube para subirlas y abrirlas en otro equipo.</span>
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
              <span>Crea una maqueta libre o parte de una canción de la librería: hereda su tempo, compás, tonalidad y secciones.</span>
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
                          {entry.cloud && cloud && canEditCloud && (
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
                              disabled={busyId !== null || (!entry.local && !(cloud && canEditCloud))}
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
        </section>

        <form className="stu-card" onSubmit={(event) => void create(event)} aria-label="Sesión nueva" data-testid="studio-new">
          <span className="stu-label">Sesión nueva</span>
          <label className="stu-form-row">
            <span className="stu-label">Punto de partida</span>
            <select className="stu-field" value={songId} onChange={(event) => setSongId(event.target.value)} data-testid="studio-new-song">
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
              <p className="stu-help">Esta canción no tiene stems en este equipo. Podrás arrastrar audio a la sesión.</p>
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
            La sesión toma la frecuencia de muestreo de este equipo. {backend === 'indexeddb' ? 'Este navegador no tiene OPFS: se puede reproducir y mezclar, no grabar.' : ''}
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
  const { songs, sharing, activeBand } = useHub()
  const band = cloudBandKey(activeBand?.id, sharing.activeShared)
  const cloudEnabled = sharing.cloudSignedIn && !!activeBand
  const cloud = useMemo(() => (cloudEnabled ? stemCloudTarget(band) : null), [cloudEnabled, band])
  // La clave incluye la banda del workspace: dos bandas personales comparten 'me' en la nube.
  return <StudioHome key={`${activeBand?.id ?? 'none'}:${band}`} band={band} bandName={activeBand?.name ?? 'Sin banda'} cloud={cloud} canEditCloud={sharing.activeCanEdit} songs={songs} />
}
