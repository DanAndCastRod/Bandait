/**
 * Reconocimiento de stems por nombre de archivo (exportaciones de Moises y archivos hechos a mano).
 *
 * Implementa exactamente las reglas de `bandait-protocol/fixtures/stem_names.json` (campo
 * `description`); el lider (Python) implementa lo mismo contra el mismo archivo. Las listas de
 * roles, etiquetas, palabras clave y extensiones estan copiadas aqui porque el bundle del hub no
 * puede importar archivos fuera de su paquete; `scripts/verify-stems-logic.ts` comprueba que esta
 * copia sea identica al fixture y que pase todos sus casos.
 *
 * Modulo puro: sin DOM ni React (se prueba con node --experimental-strip-types).
 */

export type KnownStemRole =
  | 'vocals'
  | 'backing_vocals'
  | 'drums'
  | 'bass'
  | 'guitar'
  | 'keys'
  | 'strings'
  | 'wind'
  | 'other'
  | 'instrumental'
  | 'click'
  | 'guide'

/** 'unknown': archivo de audio sin palabra clave reconocida (el usuario elige el rol). */
export type StemRole = KnownStemRole | 'unknown'

export const STEM_EXTENSIONS: readonly string[] = ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'aac']

export const STEM_ROLES: Readonly<Record<KnownStemRole, { label: string; keywords: readonly string[] }>> = {
  vocals: { label: 'Voz', keywords: ['lead vocals', 'lead vocal', 'vocals', 'vocal', 'vox', 'voz', 'voces', 'voz principal'] },
  backing_vocals: {
    label: 'Coros',
    keywords: ['backing vocals', 'backing vocal', 'back vocals', 'backing', 'bvs', 'coros', 'coro', 'segundas voces'],
  },
  drums: { label: 'Bateria', keywords: ['drums', 'drum', 'bateria', 'percussion', 'percusion', 'perc'] },
  bass: { label: 'Bajo', keywords: ['bass', 'bajo'] },
  guitar: { label: 'Guitarra', keywords: ['guitar', 'guitars', 'guitarra', 'guitarras', 'gtr'] },
  keys: {
    label: 'Teclados',
    keywords: ['piano', 'keys', 'keyboard', 'keyboards', 'teclado', 'teclados', 'synth', 'synths', 'sintetizador', 'organ', 'organo'],
  },
  strings: { label: 'Cuerdas', keywords: ['strings', 'cuerdas', 'violin', 'violins'] },
  wind: { label: 'Vientos', keywords: ['wind', 'winds', 'brass', 'metales', 'vientos', 'sax', 'trumpet'] },
  other: { label: 'Otros', keywords: ['other', 'others', 'otros', 'otro', 'rest', 'residual'] },
  instrumental: { label: 'Instrumental', keywords: ['instrumental', 'accompaniment', 'karaoke'] },
  click: { label: 'Clic', keywords: ['click', 'clic', 'metronome', 'metronomo'] },
  guide: { label: 'Guia', keywords: ['guide', 'guia', 'cues', 'cue'] },
}

export const KNOWN_STEM_ROLES = Object.keys(STEM_ROLES) as KnownStemRole[]

/** Etiqueta para mostrar de un rol ('unknown' no esta en el fixture: es texto del hub). */
export function stemRoleLabel(role: StemRole): string {
  return role === 'unknown' ? 'Sin asignar' : STEM_ROLES[role].label
}

/** Badge monoespaciado de 3 letras para la UI. */
export const STEM_ROLE_CODES: Readonly<Record<StemRole, string>> = {
  vocals: 'VOX',
  backing_vocals: 'BVS',
  drums: 'DRM',
  bass: 'BAS',
  guitar: 'GTR',
  keys: 'KEY',
  strings: 'STR',
  wind: 'WND',
  other: 'OTH',
  instrumental: 'INS',
  click: 'CLK',
  guide: 'GUI',
  unknown: '???',
}

export function isStemRole(value: unknown): value is StemRole {
  return value === 'unknown' || (typeof value === 'string' && Object.prototype.hasOwnProperty.call(STEM_ROLES, value))
}

/** Ultimo segmento de una ruta (los ZIP usan '/', Windows puede traer '\'). */
export function stemBaseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/** Extension en minusculas sin el punto, o '' si no hay. */
export function stemExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : ''
}

/** Regla 1: true si el archivo cuenta como audio (extension valida, fuera de __MACOSX/, sin '.' inicial). */
export function isStemAudioPath(path: string): boolean {
  const segments = path.split(/[\\/]/)
  if (segments.some((s) => s === '__MACOSX')) return false
  const base = segments[segments.length - 1] ?? ''
  if (base === '' || base.startsWith('.')) return false
  return STEM_EXTENSIONS.includes(stemExtension(base))
}

/**
 * Regla 2: nombre base sin extension, en minusculas, sin tildes, con _ - . ( ) [ ] cambiados por
 * espacios y los espacios colapsados.
 */
export function normalizeStemName(path: string): string {
  const base = stemBaseName(path)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return stem
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[_\-.()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

interface KeywordMatch {
  role: KnownStemRole
  /** Indice (en palabras) donde termina la coincidencia, exclusivo. */
  end: number
  length: number
}

/**
 * Regla 3: busca cada palabra clave como palabras completas; gana la coincidencia que TERMINA mas
 * tarde en el nombre y, en empate, la palabra clave mas larga. Regla 4: sin coincidencia, 'unknown'.
 * Devuelve null si el archivo no cuenta como audio (regla 1).
 */
export function recognizeStem(path: string): StemRole | null {
  if (!isStemAudioPath(path)) return null
  const normalized = normalizeStemName(path)
  if (normalized === '') return 'unknown'
  const words = normalized.split(' ')

  let best: KeywordMatch | null = null
  for (const role of KNOWN_STEM_ROLES) {
    for (const keyword of STEM_ROLES[role].keywords) {
      const kw = keyword.split(' ')
      for (let i = 0; i + kw.length <= words.length; i++) {
        let hit = true
        for (let j = 0; j < kw.length; j++) {
          if (words[i + j] !== kw[j]) {
            hit = false
            break
          }
        }
        if (!hit) continue
        const match: KeywordMatch = { role, end: i + kw.length, length: keyword.length }
        if (!best || match.end > best.end || (match.end === best.end && match.length > best.length)) best = match
      }
    }
  }
  return best ? best.role : 'unknown'
}
