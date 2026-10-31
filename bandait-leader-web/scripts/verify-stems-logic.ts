/**
 * Verificacion de la logica pura del estudio de stems:
 *   node --experimental-strip-types scripts/verify-stems-logic.ts   (parte de npm run verify:logic)
 *
 * Cubre: src/services/stemNames.ts contra TODOS los casos de bandait-protocol/fixtures/stem_names.json
 * (y que su copia de roles, etiquetas, palabras clave y extensiones sea identica al fixture), y
 * src/services/stemTiming.ts (inicio y fin de secciones, offset, recorte de la region de repeticion).
 */
import assert from 'node:assert/strict'
import fixture from '../../bandait-protocol/fixtures/stem_names.json' with { type: 'json' }
import {
  KNOWN_STEM_ROLES,
  STEM_EXTENSIONS,
  STEM_ROLES,
  isStemAudioPath,
  normalizeStemName,
  recognizeStem,
} from '../src/services/stemNames.ts'
import { barStartSeconds, clampLoop, dbToGain, formatClock, sectionSpans } from '../src/services/stemTiming.ts'
import type { SongSection } from '../src/types/hub.ts'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`  FALLA ${name}\n        ${err instanceof Error ? err.message : String(err)}`)
  }
}

function close(actual: number, expected: number, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) < eps, `esperaba ${expected}, obtuve ${actual}`)
}

function section(id: string, bars: number, label = id): SongSection {
  return { id, kind: 'custom', label, bars, chordpro: '' }
}

function main() {
  console.log('stemNames.ts contra bandait-protocol/fixtures/stem_names.json')

  check('las extensiones son las del fixture', () => {
    assert.deepEqual([...STEM_EXTENSIONS], fixture.extensions)
  })

  check('roles, etiquetas y palabras clave son las del fixture (mismo orden)', () => {
    assert.deepEqual(KNOWN_STEM_ROLES, Object.keys(fixture.roles))
    for (const role of KNOWN_STEM_ROLES) {
      const expected = (fixture.roles as Record<string, { label: string; keywords: string[] }>)[role]
      assert.equal(STEM_ROLES[role].label, expected.label, role)
      assert.deepEqual([...STEM_ROLES[role].keywords], expected.keywords, role)
    }
  })

  for (const c of fixture.cases) {
    check(`caso ${JSON.stringify(c.file)} -> ${c.role === null ? 'null' : c.role}`, () => {
      assert.equal(recognizeStem(c.file), c.role)
    })
  }

  check('normaliza tildes, separadores y espacios', () => {
    assert.equal(normalizeStemName('Moises/Guitarra  Eléctrica_(Take-2).[final].wav'), 'guitarra electrica take 2 final')
    assert.equal(normalizeStemName('C:\\stems\\Batería.WAV'), 'bateria')
  })

  check('palabras completas: "basslines" no es "bass", "overdrums" no es "drums"', () => {
    assert.equal(recognizeStem('Basslines.mp3'), 'unknown')
    assert.equal(recognizeStem('overdrums.wav'), 'unknown')
  })

  check('extension en mayusculas cuenta; sin extension o con otra, no', () => {
    assert.equal(isStemAudioPath('DRUMS.FLAC'), true)
    assert.equal(recognizeStem('drums'), null)
    assert.equal(recognizeStem('drums.mid'), null)
    assert.equal(recognizeStem('carpeta/'), null)
  })

  check('un nombre vacio tras normalizar es unknown', () => {
    assert.equal(recognizeStem('___.mp3'), 'unknown')
  })

  console.log('\nstemTiming.ts')

  check('inicio de compas: (bar-1) * beatsPerBar * 60 / bpm', () => {
    close(barStartSeconds(1, 120, 4), 0)
    close(barStartSeconds(5, 120, 4), 8)
    close(barStartSeconds(3, 90, 3), 4)
  })

  check('secciones consecutivas: cada una empieza donde termina la anterior', () => {
    const spans = sectionSpans({ bpm: 120, beatsPerBar: 4, sections: [section('intro', 4), section('verso', 8), section('coro', 8)] })
    assert.deepEqual(
      spans.map((s) => [s.id, s.startBar, s.bars]),
      [
        ['intro', 1, 4],
        ['verso', 5, 8],
        ['coro', 13, 8],
      ]
    )
    close(spans[0].startSec, 0)
    close(spans[0].endSec, 8)
    close(spans[1].startSec, 8)
    close(spans[1].endSec, 24)
    close(spans[2].startSec, 24)
    close(spans[2].endSec, 40)
  })

  check('el offset de alineacion (ms) se suma a inicio y fin', () => {
    const [intro, verso] = sectionSpans({ bpm: 100, beatsPerBar: 4, sections: [section('intro', 2), section('verso', 4)] }, 1500)
    close(intro.startSec, 1.5)
    close(intro.endSec, 1.5 + 4.8)
    close(verso.startSec, 6.3)
    close(verso.endSec, 6.3 + 9.6)
    const [neg] = sectionSpans({ bpm: 100, beatsPerBar: 4, sections: [section('intro', 2)] }, -250)
    close(neg.startSec, -0.25)
  })

  check('sin secciones o con tempo invalido no inventa tiempos', () => {
    assert.deepEqual(sectionSpans({ bpm: 120, beatsPerBar: 4, sections: [] }), [])
    assert.deepEqual(sectionSpans({ bpm: 0, beatsPerBar: 4, sections: [section('a', 4)] }), [])
    assert.deepEqual(sectionSpans({ bpm: 120, beatsPerBar: Number.NaN, sections: [section('a', 4)] }), [])
  })

  check('una seccion con compases invalidos corta la lista ahi', () => {
    const spans = sectionSpans({ bpm: 120, beatsPerBar: 4, sections: [section('a', 4), section('b', 0), section('c', 4)] })
    assert.deepEqual(
      spans.map((s) => s.id),
      ['a']
    )
  })

  check('clampLoop recorta a la duracion y descarta regiones vacias', () => {
    assert.deepEqual(clampLoop({ start: -1, end: 5 }, 10), { start: 0, end: 5 })
    assert.deepEqual(clampLoop({ start: 8, end: 20 }, 10), { start: 8, end: 10 })
    assert.equal(clampLoop({ start: 12, end: 20 }, 10), null)
    assert.equal(clampLoop({ start: 5, end: 5.01 }, 10), null)
    assert.equal(clampLoop({ start: 5, end: 3 }, 10), null)
    assert.equal(clampLoop({ start: 0, end: 1 }, 0), null)
  })

  check('formatClock y dbToGain', () => {
    assert.equal(formatClock(0), '0:00.0')
    assert.equal(formatClock(65.37), '1:05.3')
    assert.equal(formatClock(-3), '0:00.0')
    close(dbToGain(0), 1)
    close(dbToGain(-6), 0.501187233627, 1e-9)
    assert.equal(dbToGain(-60), 0)
  })

  console.log(`\n${passed} ok, ${failures.length} fallas`)
  if (failures.length > 0) process.exit(1)
}

main()
