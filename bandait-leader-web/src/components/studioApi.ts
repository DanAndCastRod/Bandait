import { createContext, useContext } from 'react'

/**
 * Lo que el prompter de ENSAYO puede pedirle al estudio de stems (StemStudio layout="rehearsal").
 * Nada aqui cambia por fotograma: la posicion se lee con position() desde un rAF o un evento.
 */
export interface StudioApi {
  /** Hay audio decodificado. */
  ready: boolean
  /** Esta sonando (cambia solo al reproducir, pausar o parar). */
  playing: boolean
  /** Reproduce o pausa. */
  togglePlay: () => void
  /** Posicion actual en segundos (lee el reproductor; no es estado de React). */
  position: () => number
  /** Lleva la reproduccion a ese segundo (y repinta la posicion aunque este en pausa). */
  seek: (sec: number) => void
  /** Id de la seccion que se repite, o null. */
  loopSectionId: string | null
  /** Repite esa seccion, o deja de repetir si ya era la que se repetia. */
  toggleSectionLoop: (sectionId: string) => void
  /** La mezcla del panel lateral esta abierta. */
  mixerOpen: boolean
  /** Pliega o abre la mezcla. */
  toggleMixer: () => void
}

const IDLE: StudioApi = {
  ready: false,
  playing: false,
  togglePlay: () => {},
  position: () => 0,
  seek: () => {},
  loopSectionId: null,
  toggleSectionLoop: () => {},
  mixerOpen: false,
  toggleMixer: () => {},
}

export const StudioApiContext = createContext<StudioApi>(IDLE)

export function useStudioApi(): StudioApi {
  return useContext(StudioApiContext)
}
