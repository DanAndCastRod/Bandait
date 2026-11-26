import {
  APPEARANCE_CACHE_KEY,
  THEME_META_COLOR,
  appearanceVars,
  parseAppearanceCache,
  serializeAppearanceCache,
  type UiPreferences,
} from './appearance'
import { defaultWaveformPreferences, normalizeWaveformPreferences, waveformPreferencesEqual, type WaveformPreferences } from './waveform'

/**
 * Evento en `window` cuando cambian el tema o el acento aplicados (no la redondez). Lo escuchan
 * quienes no pueden usar `var(--b-*)`, como los <canvas> del Estudio, para repintar con la
 * paleta nueva sin leer estilos computados en cada cuadro. `detail`: { theme, accent }.
 */
export const APPEARANCE_EVENT = 'bandait:appearance'

export interface AppearanceEventDetail {
  theme: string
  accent: string
}

/**
 * Aplica unas preferencias de apariencia al documento: `data-theme` en <html>, las variables de
 * acento, tinta y redondez, `color-scheme` y el color del navegador. Guarda la cache del
 * dispositivo que lee el script de index.html para no parpadear en la proxima carga.
 */
export function applyAppearance(prefs: UiPreferences, doc: Document = document): void {
  const { theme, vars } = appearanceVars(prefs)
  const root = doc.documentElement
  const before = `${root.dataset.theme ?? ''}|${root.style.getPropertyValue('--b-accent')}`
  if (root.dataset.theme !== theme) root.dataset.theme = theme
  for (const [name, value] of Object.entries(vars)) {
    if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value)
  }
  root.style.colorScheme = theme === 'light-estudio' ? 'light' : 'dark'
  const meta = doc.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', THEME_META_COLOR[theme])
  const accent = root.style.getPropertyValue('--b-accent')
  const view = doc.defaultView
  if (view && `${theme}|${accent}` !== before) {
    view.dispatchEvent(new CustomEvent<AppearanceEventDetail>(APPEARANCE_EVENT, { detail: { theme, accent } }))
  }
  try {
    localStorage.setItem(APPEARANCE_CACHE_KEY, serializeAppearanceCache(prefs))
  } catch {
    // sin almacenamiento (modo privado o bloqueado) la apariencia igual queda aplicada
  }
  setWaveformPreferences(prefs.waveform)
}

// ---------------------------------------------------------------------------
// Forma de onda vigente: un almacen pequeno para los lienzos (useWaveformPreferences). Los
// bucles de pintado guardan el objeto en una ref y repintan solo cuando cambia.
// ---------------------------------------------------------------------------

let currentWaveform: WaveformPreferences | null = null
const waveformListeners = new Set<() => void>()

function setWaveformPreferences(next: WaveformPreferences | undefined): void {
  const clean = normalizeWaveformPreferences(next)
  if (currentWaveform && waveformPreferencesEqual(currentWaveform, clean)) return
  currentWaveform = clean
  for (const listener of [...waveformListeners]) listener()
}

/** Forma de onda vigente (el mismo objeto mientras no cambie). */
export function getWaveformPreferences(): WaveformPreferences {
  if (!currentWaveform) currentWaveform = readCachedPreferences()?.waveform ?? defaultWaveformPreferences()
  return currentWaveform
}

/** Avisa cuando cambia la forma de onda. Devuelve la funcion para dejar de escuchar. */
export function subscribeWaveformPreferences(listener: () => void): () => void {
  waveformListeners.add(listener)
  return () => {
    waveformListeners.delete(listener)
  }
}

/** Preferencias de la cache del dispositivo (las del ultimo que uso este navegador), o null. */
export function readCachedPreferences(): UiPreferences | null {
  try {
    return parseAppearanceCache(localStorage.getItem(APPEARANCE_CACHE_KEY))?.prefs ?? null
  } catch {
    return null
  }
}
