import { createContext, useContext } from 'react'

/** Lo que el prompter de ENSAYO puede pedirle al estudio de stems (StemStudio layout="rehearsal"). */
export interface StudioApi {
  /** Hay audio decodificado. */
  ready: boolean
  /** Lleva la reproduccion a ese segundo (y repinta la posicion aunque este en pausa). */
  seek: (sec: number) => void
  /** Id de la seccion que se repite, o null. */
  loopSectionId: string | null
  /** Repite esa seccion, o deja de repetir si ya era la que se repetia. */
  toggleSectionLoop: (sectionId: string) => void
}

const IDLE: StudioApi = { ready: false, seek: () => {}, loopSectionId: null, toggleSectionLoop: () => {} }

export const StudioApiContext = createContext<StudioApi>(IDLE)

export function useStudioApi(): StudioApi {
  return useContext(StudioApiContext)
}
