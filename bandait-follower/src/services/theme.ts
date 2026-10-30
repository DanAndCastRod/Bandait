/**
 * Tema de la PWA. Grafito (2026-10-30) es el predeterminado: la paleta del lider y del hub,
 * sin blanco puro ni acentos saturados sobre negro, que cansaban la vista en escenario.
 */
export type ThemeStyle = 'theme-grafito' | 'theme-swiss' | 'theme-milspec' | 'theme-tokyo' | 'theme-concert'

export const DEFAULT_THEME: ThemeStyle = 'theme-grafito'
export const THEME_KEY = 'bandait_theme'
/** Marca de que la preferencia ya paso por la migracion a Grafito. */
export const THEME_MIGRATED_KEY = 'bandait_theme_grafito'

const KNOWN: readonly ThemeStyle[] = ['theme-grafito', 'theme-swiss', 'theme-milspec', 'theme-tokyo', 'theme-concert']

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * Tema guardado. Hasta 2026-10-30 la app guardaba 'theme-swiss' apenas abria (era el
 * predeterminado), asi que un 'theme-swiss' sin la marca de migracion no es una eleccion:
 * pasa a Grafito una sola vez. Un tema elegido a proposito (milspec, tokyo, concert) se respeta.
 */
export function resolveTheme(storage: StorageLike | null): ThemeStyle {
  try {
    if (!storage) return DEFAULT_THEME
    const saved = storage.getItem(THEME_KEY) as ThemeStyle | null
    const migrated = storage.getItem(THEME_MIGRATED_KEY) === '1'
    if (!migrated) {
      storage.setItem(THEME_MIGRATED_KEY, '1')
      if (!saved || saved === 'theme-swiss') {
        storage.setItem(THEME_KEY, DEFAULT_THEME)
        return DEFAULT_THEME
      }
    }
    return saved && KNOWN.includes(saved) ? saved : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

export function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}
