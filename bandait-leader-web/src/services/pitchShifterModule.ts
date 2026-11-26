/**
 * URL del worklet del cambio de tono. Vive en un modulo aparte, que stemPlayer.ts carga con
 * import() dinamico (mismo motivo que services/studio/limiterModule.ts):
 *   - `?worker&url` hace que Vite compile pitchShifter.worklet.ts (TypeScript, con sus imports)
 *     como un archivo propio y entregue su URL;
 *   - node no entiende ese sufijo: al estar aislado aqui, stemPlayer.ts se puede importar desde
 *     los scripts de verificacion.
 */
import workletUrl from './pitchShifter.worklet.ts?worker&url'

export const PITCH_SHIFTER_WORKLET_URL: string = workletUrl
