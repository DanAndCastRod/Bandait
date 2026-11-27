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

/**
 * Pedido explicito de abrir una cancion en ENSAYO o en STEMS (el salto de la barra del Universo
 * de la Cancion). Sin el, esas vistas retoman lo que suena en el reproductor global. `nonce`
 * distingue dos pedidos de la misma cancion.
 */
export interface SongFocusRequest {
  songId: string
  nonce: number
}

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

/**
 * Las tres pildoras fijas de la barra movil; con "Mas" son 4 (docs/REQUERIMIENTOS_WEB_3.0.md). El
 * Estudio DAW va en la hoja "Mas", primero de la lista (decision de Daniel Castaneda, 2026-11-27).
 */
export const MOBILE_BAR_VIEWS: readonly HubView[] = ['rehearsal', 'songs', 'setlists']

export function viewDef(id: HubView): HubViewDef | undefined {
  return HUB_VIEWS.find((view) => view.id === id)
}

/** Estado del rail (244 px o 72 px), por navegador. */
export const RAIL_STORAGE_KEY = 'bandait_hub_rail'

/**
 * El Estudio recuerda su propio estado del rail y arranca plegado (72 px): la linea de tiempo y
 * el piano roll son lo principal y a 1280 px el rail abierto les quitaba casi un tercio del ancho.
 */
export const RAIL_STUDIO_STORAGE_KEY = 'bandait_hub_rail_studio'

export type RailScope = 'hub' | 'studio'

function railKey(scope: RailScope): string {
  return scope === 'studio' ? RAIL_STUDIO_STORAGE_KEY : RAIL_STORAGE_KEY
}

export function readRailCollapsed(scope: RailScope = 'hub'): boolean {
  const fallback = scope === 'studio'
  try {
    if (typeof localStorage === 'undefined') return fallback
    const stored = localStorage.getItem(railKey(scope))
    return stored === null ? fallback : stored === 'collapsed'
  } catch {
    // Navegacion privada o almacenamiento bloqueado: el valor por defecto de cada ambito.
    return fallback
  }
}

export function writeRailCollapsed(collapsed: boolean, scope: RailScope = 'hub'): void {
  try {
    localStorage.setItem(railKey(scope), collapsed ? 'collapsed' : 'expanded')
  } catch {
    // Sin almacenamiento: el estado dura lo que la pestana.
  }
}

/** Corte de escritorio: >= 768 px rail; por debajo, barra inferior de pildoras. */
export const DESKTOP_QUERY = '(min-width: 768px)'
