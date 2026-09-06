import { describe, it, expect } from 'vitest'
import { calculateDiffPreview } from '../xlsxService'
import { ExcelMasterWorkbook } from '../../types/xlsx'

describe('xlsxService calculateDiffPreview', () => {
  const current: ExcelMasterWorkbook = {
    canciones: [
      {
        id: 's1',
        titulo: 'Cancion A',
        artista: 'Artista 1',
        bpm_original: 120,
        tono_original: 'Am',
        duracion_segundos: 200,
        letra_chordpro: '[Am]Letra',
      },
      {
        id: 's2',
        titulo: 'Cancion B',
        artista: 'Artista 1',
        bpm_original: 100,
        tono_original: 'G',
        duracion_segundos: 180,
        letra_chordpro: '[G]Letra',
      },
    ],
    setlists: [
      {
        setlist_id: 'sl1',
        nombre_show: 'Festival',
        cancion_id: 's1',
        orden: 1,
        tono_show: 'Am',
        modo_transicion: 'manual_cue',
        notas: 'Entrada fuerte',
      },
    ],
    equipo: [
      {
        usuario_id: 'u1',
        nombre: 'Director Musical',
        telefono: '+573001234567',
        rol: 'MusicDirector',
      },
    ],
  }

  it('detects added, updated, deleted and unchanged items', () => {
    const incoming: ExcelMasterWorkbook = {
      canciones: [
        // Updated: BPM changed from 120 to 128
        {
          id: 's1',
          titulo: 'Cancion A',
          artista: 'Artista 1',
          bpm_original: 128,
          tono_original: 'Am',
          duracion_segundos: 200,
          letra_chordpro: '[Am]Letra',
        },
        // Added: new song s3
        {
          id: 's3',
          titulo: 'Cancion C',
          artista: 'Artista 2',
          bpm_original: 140,
          tono_original: 'D',
          duracion_segundos: 220,
          letra_chordpro: '[D]Letra',
        },
        // s2 is deleted
      ],
      setlists: [
        // Unchanged
        {
          setlist_id: 'sl1',
          nombre_show: 'Festival',
          cancion_id: 's1',
          orden: 1,
          tono_show: 'Am',
          modo_transicion: 'manual_cue',
          notas: 'Entrada fuerte',
        },
      ],
      equipo: [
        {
          usuario_id: 'u1',
          nombre: 'Director Musical',
          telefono: '+573001234567',
          rol: 'MusicDirector',
        },
        // Added substitute
        {
          usuario_id: 'u2',
          nombre: 'Músico Sustituto',
          telefono: '+573009998877',
          rol: 'Substitute',
        },
      ],
    }

    const diff = calculateDiffPreview(current, incoming)

    expect(diff.has_changes).toBe(true)
    expect(diff.summary.added).toBe(2) // s3 and u2
    expect(diff.summary.updated).toBe(1) // s1
    expect(diff.summary.deleted).toBe(1) // s2
    expect(diff.summary.unchanged).toBe(2) // sl1/s1 and u1

    // Verify detailed field diff for updated item
    const song1Diff = diff.canciones.find((c) => c.entity_id === 's1')
    expect(song1Diff?.change_type).toBe('updated')
    expect(song1Diff?.diff_fields?.bpm_original).toEqual({
      before: 120,
      after: 128,
    })
  })
})
