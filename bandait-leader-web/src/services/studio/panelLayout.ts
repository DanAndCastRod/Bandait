/**
 * Disposicion de los paneles del Estudio (ola 2 de Web 3.0, 2026-11-26): la consola de mezcla
 * abajo y el panel lateral (inspector, dispositivo, trabajos de IA) se pliegan a un clic, y el
 * estado se recuerda en este navegador. La linea de tiempo y el piano roll ocupan el resto.
 *
 * Modulo puro: sin DOM ni React (se prueba en scripts/verify-studio-layout.ts). La vista lee y
 * escribe con un almacen que nunca lanza (studioKeymapStorage).
 */

export type StudioSideTab = 'device' | 'inspector' | 'jobs'

export const STUDIO_SIDE_TABS: readonly StudioSideTab[] = ['inspector', 'device', 'jobs']

export const STUDIO_SIDE_TAB_LABELS: Readonly<Record<StudioSideTab, string>> = {
  inspector: 'Inspector',
  device: 'Dispositivo',
  jobs: 'Trabajos de IA',
}

export interface StudioPanelLayout {
  /** Panel lateral desplegado (plegado queda el riel de iconos, siempre a la vista). */
  sideOpen: boolean
  sideTab: StudioSideTab
  /** Consola de mezcla desplegada (plegada queda su barra con el boton y EXPORTAR). */
  mixerOpen: boolean
}

export const PANEL_LAYOUT_STORAGE_KEY = 'bandait_studio_panels'
/** Clave anterior del mezclador ('0' = plegado): se respeta si no hay disposicion guardada. */
export const LEGACY_MIXER_STORAGE_KEY = 'bandait_studio_mixer'

export function defaultPanelLayout(): StudioPanelLayout {
  return { sideOpen: true, sideTab: 'device', mixerOpen: true }
}

function isTab(value: unknown): value is StudioSideTab {
  return typeof value === 'string' && (STUDIO_SIDE_TABS as readonly string[]).includes(value)
}

/** Disposicion guardada, con lectura tolerante: lo invalido toma el valor por defecto. */
export function parsePanelLayout(raw: string | null, legacyMixer: string | null = null): StudioPanelLayout {
  const d = defaultPanelLayout()
  const legacy = legacyMixer === '0' ? { ...d, mixerOpen: false } : d
  if (!raw) return legacy
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return legacy
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return legacy
  const v = data as Record<string, unknown>
  return {
    sideOpen: typeof v.sideOpen === 'boolean' ? v.sideOpen : d.sideOpen,
    sideTab: isTab(v.sideTab) ? v.sideTab : d.sideTab,
    mixerOpen: typeof v.mixerOpen === 'boolean' ? v.mixerOpen : legacy.mixerOpen,
  }
}

export function serializePanelLayout(layout: StudioPanelLayout): string {
  return JSON.stringify({ sideOpen: layout.sideOpen, sideTab: layout.sideTab, mixerOpen: layout.mixerOpen })
}

export function toggleMixer(layout: StudioPanelLayout): StudioPanelLayout {
  return { ...layout, mixerOpen: !layout.mixerOpen }
}

export function toggleSidePanel(layout: StudioPanelLayout): StudioPanelLayout {
  return { ...layout, sideOpen: !layout.sideOpen }
}

/**
 * Abre el panel lateral en una pestana (el mismo objeto si ya estaba asi). Un icono del riel
 * siempre abre: plegar es el boton propio del riel o Alt+P, asi un clic nunca esconde lo que se
 * fue a buscar.
 */
export function showSideTab(layout: StudioPanelLayout, tab: StudioSideTab): StudioPanelLayout {
  if (layout.sideOpen && layout.sideTab === tab) return layout
  return { ...layout, sideOpen: true, sideTab: tab }
}
