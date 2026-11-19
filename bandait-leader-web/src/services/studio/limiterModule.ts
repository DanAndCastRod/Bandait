/**
 * URL del worklet del limitador. Vive en un modulo aparte, que graph.ts carga con import()
 * dinamico, por dos motivos:
 *   - `?worker&url` hace que Vite compile limiter.worklet.ts (TypeScript, con sus imports) como
 *     un archivo propio y entregue su URL; `new URL('./x.ts', import.meta.url)` lo copiaria sin
 *     compilar.
 *   - node no entiende ese sufijo: al estar aislado aqui, graph.ts y el resto del motor se pueden
 *     importar desde los scripts de verificacion.
 */
import workletUrl from './limiter.worklet.ts?worker&url'

export const LIMITER_WORKLET_URL: string = workletUrl
