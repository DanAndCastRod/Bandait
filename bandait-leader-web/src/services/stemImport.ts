/**
 * Lectura de lo que el usuario suelta en el importador de stems: un ZIP (exportacion de Moises u
 * otra) y/o archivos de audio sueltos. Devuelve candidatos reconocidos por nombre
 * (services/stemNames.ts) y la lista de lo ignorado, sin tocar el almacen.
 *
 * ZIP con fflate (async: descomprime en workers y no congela la vista). Se descarta
 * DecompressionStream('deflate-raw') porque obliga a escribir a mano el lector del directorio
 * central del ZIP (descriptores de datos, entradas "stored", nombres en CP437/UTF-8), que es justo
 * la parte fragil; fflate ya la resuelve, y se carga aparte solo cuando hace falta.
 */
import type { Unzipped } from 'fflate'
import { recognizeStem, stemBaseName, stemExtension, stemRoleLabel, type StemRole } from './stemNames'

export interface StemCandidate {
  key: string
  /** Ruta dentro del ZIP o nombre del archivo suelto. */
  path: string
  fileName: string
  role: StemRole
  blob: Blob
  /** Origen para mostrar: nombre del ZIP o 'archivo suelto'. */
  source: string
}

export interface ImportScan {
  candidates: StemCandidate[]
  /** Archivos que no cuentan como audio (regla 1 del fixture). */
  ignored: string[]
  /** Errores legibles por archivo (ZIP corrupto, archivo vacio...). */
  errors: string[]
}

/** Limite por ZIP: se lee entero en memoria antes de descomprimir. */
export const MAX_ZIP_BYTES = 1024 * 1024 * 1024

const MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
}

let seq = 0
function nextKey(): string {
  seq += 1
  return `cand_${seq}`
}

function isZip(file: File): boolean {
  return stemExtension(file.name) === 'zip' || file.type === 'application/zip' || file.type === 'application/x-zip-compressed'
}

/** Descomprime solo las entradas de audio; `ignored` recibe el resto que vale la pena mostrar. */
async function unzipAsync(data: Uint8Array, ignored: string[]): Promise<Unzipped> {
  // Carga diferida: fflate solo se descarga cuando alguien suelta un ZIP.
  const { unzip } = await import('fflate')
  return new Promise((resolve, reject) => {
    const filter = (info: { name: string }) => {
      const keep = recognizeStem(info.name) !== null
      // Carpetas, metadatos de macOS (__MACOSX/, ._x) y ocultos no se listan: son ruido.
      if (!keep && !info.name.endsWith('/') && !/(^|\/)(__MACOSX\/|\.)/.test(info.name)) ignored.push(info.name)
      return keep
    }
    unzip(data, { filter }, (err, files) => {
      if (err) reject(err)
      else resolve(files)
    })
  })
}

/** Tamano en texto para la UI. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export async function scanImportFiles(files: File[]): Promise<ImportScan> {
  const scan: ImportScan = { candidates: [], ignored: [], errors: [] }
  for (const file of files) {
    if (isZip(file)) {
      if (file.size > MAX_ZIP_BYTES) {
        scan.errors.push(`${file.name}: el ZIP pesa más de 1 GB; descomprímelo y suelta los archivos de audio.`)
        continue
      }
      let entries: Unzipped
      const ignored: string[] = []
      try {
        const data = new Uint8Array(await file.arrayBuffer())
        entries = await unzipAsync(data, ignored)
      } catch {
        scan.errors.push(`${file.name}: no se pudo leer el ZIP (archivo dañado o formato no soportado).`)
        continue
      }
      for (const name of ignored) scan.ignored.push(`${file.name}: ${name}`)
      const names = Object.keys(entries).sort((a, b) => a.localeCompare(b, 'es'))
      if (names.length === 0) scan.errors.push(`${file.name}: el ZIP no trae archivos de audio (mp3, m4a, wav, flac, ogg, aac).`)
      for (const name of names) {
        const role = recognizeStem(name)
        const bytes = entries[name]
        if (role === null) continue
        if (!bytes || bytes.length === 0) {
          scan.errors.push(`${file.name}: ${name} está vacío.`)
          continue
        }
        const fileName = stemBaseName(name)
        scan.candidates.push({
          key: nextKey(),
          path: name,
          fileName,
          role,
          blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: MIME_BY_EXT[stemExtension(fileName)] ?? '' }),
          source: file.name,
        })
      }
      continue
    }

    const role = recognizeStem(file.name)
    if (role === null) {
      scan.ignored.push(file.name)
      continue
    }
    if (file.size === 0) {
      scan.errors.push(`${file.name}: el archivo está vacío.`)
      continue
    }
    scan.candidates.push({
      key: nextKey(),
      path: file.name,
      fileName: file.name,
      role,
      blob: file.type ? file : new Blob([file], { type: MIME_BY_EXT[stemExtension(file.name)] ?? '' }),
      source: 'archivo suelto',
    })
  }
  return scan
}

/** Etiquetas por defecto: la del rol, numeradas si el rol se repite ("Guitarra 2"). */
export function defaultLabels(roles: StemRole[], existing: string[] = []): string[] {
  const used = new Set(existing)
  return roles.map((role) => {
    const base = stemRoleLabel(role)
    let label = base
    let n = 2
    while (used.has(label)) label = `${base} ${n++}`
    used.add(label)
    return label
  })
}
