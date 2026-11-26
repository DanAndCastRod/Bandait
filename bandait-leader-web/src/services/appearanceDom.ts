import {
  APPEARANCE_CACHE_KEY,
  THEME_META_COLOR,
  appearanceVars,
  parseAppearanceCache,
  serializeAppearanceCache,
  type UiPreferences,
} from './appearance'

/**
 * Aplica unas preferencias de apariencia al documento: `data-theme` en <html>, las variables de
 * acento, tinta y redondez, `color-scheme` y el color del navegador. Guarda la cache del
 * dispositivo que lee el script de index.html para no parpadear en la proxima carga.
 */
export function applyAppearance(prefs: UiPreferences, doc: Document = document): void {
  const { theme, vars } = appearanceVars(prefs)
  const root = doc.documentElement
  if (root.dataset.theme !== theme) root.dataset.theme = theme
  for (const [name, value] of Object.entries(vars)) {
    if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value)
  }
  root.style.colorScheme = theme === 'light-estudio' ? 'light' : 'dark'
  const meta = doc.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', THEME_META_COLOR[theme])
  try {
    localStorage.setItem(APPEARANCE_CACHE_KEY, serializeAppearanceCache(prefs))
  } catch {
    // sin almacenamiento (modo privado o bloqueado) la apariencia igual queda aplicada
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
