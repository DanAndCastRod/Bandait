/**
 * Bandait 3.0 — Client-side XLSX Diff Preview and Reconciler
 */

import {
  ExcelMasterWorkbook,
  ExcelSongRow,
  ExcelSetlistRow,
  ExcelEquipoRow,
  DiffPreview,
  DiffItem,
  DiffFieldChange,
} from '../types/xlsx'
import { saveSetlist, StoredSetlist, StoredSong } from '../db/indexedDb'

function diffEntities<T extends object>(
  current: T[],
  incoming: T[],
  idKey: keyof T
): DiffItem<T>[] {
  const diffItems: DiffItem<T>[] = []
  const currentMap = new Map<string, T>()
  const incomingMap = new Map<string, T>()

  current.forEach((item) => {
    const id = String(item[idKey] || '')
    if (id) currentMap.set(id, item)
  })

  incoming.forEach((item) => {
    const id = String(item[idKey] || '')
    if (id) incomingMap.set(id, item)
  })

  // Identify added and updated
  incomingMap.forEach((incItem, id) => {
    if (!currentMap.has(id)) {
      diffItems.push({
        entity_id: id,
        change_type: 'added',
        details: incItem,
      })
    } else {
      const currItem = currentMap.get(id)!
      const fieldDiffs: Record<string, DiffFieldChange> = {}
      const incRecord = incItem as unknown as Record<string, unknown>
      const currRecord = currItem as unknown as Record<string, unknown>

      Object.keys(incRecord).forEach((key) => {
        const currVal = currRecord[key]
        const incVal = incRecord[key]
        if (currVal !== incVal) {
          fieldDiffs[key] = { before: currVal, after: incVal }
        }
      })

      if (Object.keys(fieldDiffs).length > 0) {
        diffItems.push({
          entity_id: id,
          change_type: 'updated',
          details: incItem,
          diff_fields: fieldDiffs,
        })
      } else {
        diffItems.push({
          entity_id: id,
          change_type: 'unchanged',
          details: incItem,
        })
      }
    }
  })

  // Identify deleted
  currentMap.forEach((currItem, id) => {
    if (!incomingMap.has(id)) {
      diffItems.push({
        entity_id: id,
        change_type: 'deleted',
        details: currItem,
      })
    }
  })

  return diffItems
}

export function calculateDiffPreview(
  current: ExcelMasterWorkbook,
  incoming: ExcelMasterWorkbook
): DiffPreview {
  const canciones = diffEntities<ExcelSongRow>(
    current.canciones,
    incoming.canciones,
    'id'
  )

  const setlists = diffEntities<ExcelSetlistRow>(
    current.setlists,
    incoming.setlists,
    'cancion_id'
  )

  const equipo = diffEntities<ExcelEquipoRow>(
    current.equipo,
    incoming.equipo,
    'usuario_id'
  )

  const allItems = [...canciones, ...setlists, ...equipo]

  const summary = {
    added: allItems.filter((i) => i.change_type === 'added').length,
    updated: allItems.filter((i) => i.change_type === 'updated').length,
    deleted: allItems.filter((i) => i.change_type === 'deleted').length,
    unchanged: allItems.filter((i) => i.change_type === 'unchanged').length,
  }

  const has_changes = summary.added + summary.updated + summary.deleted > 0

  return {
    canciones,
    setlists,
    equipo,
    has_changes,
    summary,
  }
}

const MASTER_STORAGE_KEY = 'bandait_master_workbook'

export function getCurrentMasterWorkbook(): ExcelMasterWorkbook {
  const raw = localStorage.getItem(MASTER_STORAGE_KEY)
  if (raw) {
    try {
      return JSON.parse(raw)
    } catch {
      // Fallback to empty
    }
  }
  return {
    canciones: [],
    setlists: [],
    equipo: [],
  }
}

export async function applyMasterWorkbookToDb(workbook: ExcelMasterWorkbook): Promise<void> {
  // Store raw master workbook in localStorage for diff comparison
  localStorage.setItem(MASTER_STORAGE_KEY, JSON.stringify(workbook))

  // Index songs
  const songMap = new Map<string, StoredSong>()
  workbook.canciones.forEach((c) => {
    songMap.set(c.id, {
      id: c.id,
      title: c.titulo,
      bpm: c.bpm_original,
      key: c.tono_original,
      segments: [],
      lyrics: [{ time: 0, text: c.letra_chordpro }],
    })
  })

  // Group setlists by setlist_id
  const setlistMap = new Map<string, StoredSetlist>()
  workbook.setlists.forEach((row) => {
    if (!setlistMap.has(row.setlist_id)) {
      setlistMap.set(row.setlist_id, {
        id: row.setlist_id,
        name: row.nombre_show,
        songs: [],
      })
    }
    const sl = setlistMap.get(row.setlist_id)!
    const song = songMap.get(row.cancion_id) || {
      id: row.cancion_id,
      title: `Canción ${row.cancion_id}`,
      bpm: 120,
      key: row.tono_show,
      segments: [],
      lyrics: [],
    }
    sl.songs.push(song)
  })

  // Save to IndexedDB
  for (const sl of setlistMap.values()) {
    await saveSetlist(sl)
  }
}

export function getSampleIncomingWorkbook(): ExcelMasterWorkbook {
  return {
    canciones: [
      {
        id: 'song_1',
        titulo: 'Medianoche en Pereira (Show Cut)',
        artista: 'Los Inquietos',
        bpm_original: 124,
        tono_original: 'Am',
        duracion_segundos: 245,
        letra_chordpro: '{title: Medianoche en Pereira}\n[Am]Noche fria [F]en el bar',
      },
      {
        id: 'song_2',
        titulo: 'Ritmo de Calle',
        artista: 'Banda Local',
        bpm_original: 138,
        tono_original: 'Em',
        duracion_segundos: 210,
        letra_chordpro: '[Em]El ritmo de la calle',
      },
      {
        id: 'song_new_1',
        titulo: 'Amanecer en el Valle',
        artista: 'Los Inquietos',
        bpm_original: 110,
        tono_original: 'D',
        duracion_segundos: 195,
        letra_chordpro: '[D]Sale el sol sobre el valle',
      },
    ],
    setlists: [
      {
        setlist_id: 'show_pereira_2026',
        nombre_show: 'Festival Rock Pereira 2026',
        cancion_id: 'song_1',
        orden: 1,
        tono_show: 'Am',
        modo_transicion: 'manual_cue',
        notas: 'Entrada con conteo de platillo',
      },
      {
        setlist_id: 'show_pereira_2026',
        nombre_show: 'Festival Rock Pereira 2026',
        cancion_id: 'song_2',
        orden: 2,
        tono_show: 'Em',
        modo_transicion: 'gapless',
        notas: 'Enganche directo',
      },
      {
        setlist_id: 'show_pereira_2026',
        nombre_show: 'Festival Rock Pereira 2026',
        cancion_id: 'song_new_1',
        orden: 3,
        tono_show: 'D',
        modo_transicion: 'auto_count_in',
        notas: 'Conteo 2 compases',
      },
    ],
    equipo: [
      {
        usuario_id: 'usr_dir',
        nombre: 'Director Musical',
        telefono: '+573001234567',
        rol: 'MusicDirector',
      },
      {
        usuario_id: 'usr_drum',
        nombre: 'Baterista Principal',
        telefono: '+573009876543',
        rol: 'Musician',
      },
      {
        usuario_id: 'usr_foh',
        nombre: 'Técnico FOH',
        telefono: '+573005556677',
        rol: 'SoundEngineer',
      },
    ],
  }
}
