import type React from 'react'
import { ListMusic, Mic, Music, Settings, SlidersVertical, Users } from 'lucide-react'
import { studioEnabled } from '../../services/studio/flag'

/**
 * Vistas del Hub Web 3.0 (docs/REQUERIMIENTOS_WEB_3.0.md, seccion 2), en el orden del rail. La
 * antigua PISTAS vive dentro de Canciones y Stems (segmento STEMS Y PISTAS). El Hub no tiene
 * Escenario: una pagina HTTPS no puede abrir ws:// hacia el lider en la LAN (contenido mixto).
 */
export type HubView = 'studio' | 'rehearsal' | 'songs' | 'setlists' | 'band' | 'settings'

/** Segmento de Canciones y Stems: LIBRERIA (SongsHubView) o STEMS Y PISTAS (StemsHubView). */
export type SongsSegment = 'library' | 'stems'

export interface HubViewDef {
  id: HubView
  /** Nombre en el rail de escritorio. */
  label: string
  /** Nombre corto en la barra y la hoja del movil. */
  short: string
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; style?: React.CSSProperties; 'aria-hidden'?: boolean }>
}

const ALL_VIEWS: readonly HubViewDef[] = [
  { id: 'studio', label: 'Estudio DAW', short: 'Estudio DAW', icon: SlidersVertical },
  { id: 'rehearsal', label: 'Ensayo y Prompter', short: 'Ensayo', icon: Mic },
  { id: 'songs', label: 'Canciones y Stems', short: 'Canciones', icon: Music },
  { id: 'setlists', label: 'Setlists', short: 'Setlists', icon: ListMusic },
  { id: 'band', label: 'Banda', short: 'Banda', icon: Users },
  { id: 'settings', label: 'Ajustes', short: 'Ajustes', icon: Settings },
]

/** El Estudio esta encendido por defecto; services/studio/flag.ts permite apagarlo y entonces su vista no existe. */
export const HUB_VIEWS: readonly HubViewDef[] = ALL_VIEWS.filter((view) => view.id !== 'studio' || studioEnabled())

/** Las tres pildoras fijas de la barra movil; el resto va en la hoja "Mas". */
export const MOBILE_BAR_VIEWS: readonly HubView[] = ['rehearsal', 'songs', 'setlists']

export function viewDef(id: HubView): HubViewDef | undefined {
  return HUB_VIEWS.find((view) => view.id === id)
}

/** Estado del rail (244 px o 72 px), por navegador. */
export const RAIL_STORAGE_KEY = 'bandait_hub_rail'

export function readRailCollapsed(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(RAIL_STORAGE_KEY) === 'collapsed'
  } catch {
    // Navegacion privada o almacenamiento bloqueado: rail abierto.
    return false
  }
}

export function writeRailCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(RAIL_STORAGE_KEY, collapsed ? 'collapsed' : 'expanded')
  } catch {
    // Sin almacenamiento: el estado dura lo que la pestana.
  }
}

/** Corte de escritorio: >= 768 px rail; por debajo, barra inferior de pildoras. */
export const DESKTOP_QUERY = '(min-width: 768px)'
