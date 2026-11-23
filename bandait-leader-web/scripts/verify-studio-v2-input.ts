/**
 * Verificacion de la logica pura de la entrada MIDI, audio a MIDI y el cliente de IA del Estudio v2:
 *   node --experimental-strip-types --no-warnings scripts/verify-studio-v2-input.ts
 *
 * Cubre: src/services/studio/midiInput.ts (mensajes MIDI, reloj performance -> AudioContext,
 * toma a clip con conteo, loop, canal y cuantizado; la clase con un Web MIDI simulado y el teclado
 * de la computadora), audioToMidi.ts (conversion de los eventos de Basic Pitch; sin el modelo),
 * studioCloud.ts y jobs.ts para compose, analyze y chat contra un Worker simulado, y
 * assistantTools.ts contra bandait-protocol/fixtures/studio_chat_tools_v2.json y el registro de
 * commands.ts.
 *
 * Nada de esto toca la red, el navegador ni datos reales.
 */
import assert from 'node:assert/strict'
import sessionFixtureV2 from '../../bandait-protocol/fixtures/studio_session_v2.json' with { type: 'json' }
import chatToolsFixture from '../../bandait-protocol/fixtures/studio_chat_tools_v2.json' with { type: 'json' }
import { StemCloudError, type CloudTarget } from '../src/services/stemCloud.ts'
import { parseSession, type StudioMidiNote, type StudioSession } from '../src/services/studio/session.ts'
import {
  MIDI_EARLY_TOLERANCE_S,
  StudioMidiInput,
  clockStamp,
  computerKeyPitch,
  eventsToTake,
  isTextFieldTarget,
  parseMidiMessage,
  performanceToCtxTime,
  type MidiAccessLike,
  type MidiInputPortLike,
  type MidiTakeOptions,
} from '../src/services/studio/midiInput.ts'
import { parseChatMarkdown, parseInline } from '../src/services/studio/chatMarkdown.ts'
import { amplitudeToVelocity, availability, minNoteFrames, noteEventsToStudioNotes, transcribe } from '../src/services/studio/audioToMidi.ts'
import {
  STUDIO_CHAT_BODY_MAX_BYTES,
  estimateJobV2,
  getJobV2,
  jobRequestV2ToWire,
  parseJobStateV2,
  sessionSummaryToWire,
  startJobV2,
  watchJobV2,
} from '../src/services/studio/studioCloud.ts'
import {
  CHAT_MAX_MESSAGES,
  CHAT_SUMMARY_MAX_BYTES,
  analysisSessionPatch,
  analysisToMarkers,
  appendModelReply,
  appendToolResults,
  appendUserMessage,
  buildSessionSummary,
  chatRequestForSession,
  chatRequestProblem,
  chatToolMode,
  composeRequestForSession,
  composeResultToClip,
  fitSessionSummary,
  jobRequestProblemV2,
  jobStatusTextV2,
  readPendingJobV2,
  runJobV2,
  sessionSummaryBytes,
  soundingClipNotes,
  trimChatMessages,
  writePendingJob,
  type ChatView,
} from '../src/services/studio/jobs.ts'
import {
  STUDIO_ASSISTANT_TOOLS,
  applyPendingCommand,
  beatPositionText,
  buildToolResults,
  checkToolArguments,
  describeToolCall,
  prepareToolCalls,
  rejectPendingCommand,
  toolResultsMessage,
} from '../src/services/studio/assistantTools.ts'
import { STUDIO_COMMAND_SPECS, createCommandRegistry } from '../src/services/studio/commands.ts'
import {
  ASSISTANT_CHAT_MAX_STORED,
  ASSISTANT_DOCK_MAX_W,
  ASSISTANT_DOCK_MIN_W,
  ASSISTANT_EDGE_PX,
  ASSISTANT_FLOAT_MIN_H,
  ASSISTANT_FLOAT_MIN_W,
  assistantContextChips,
  auditionZone,
  barRangeText,
  clampDockWidth,
  clampFloatRect,
  defaultAssistantLayout,
  parseAssistantLayout,
  parseStoredAssistantChat,
  quickActionText,
  serializeAssistantChat,
  serializeAssistantLayout,
  toggleAssistantLayout,
  withAssistantMode,
  type StoredAssistantChat,
} from '../src/services/studio/assistantWindow.ts'
import type {
  ChatJobRequest,
  ComposeJobRequest,
  MidiNoteEvent,
  StudioChatMessage,
  StudioChatToolCall,
  StudioJobStateV2,
} from '../src/services/studio/types.ts'

let passed = 0
const failures: string[] = []
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`  FALLA ${name}\n        ${err instanceof Error ? err.message : String(err)}`)
  }
}

function close(actual: number, expected: number, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= eps, `esperaba ${expected} (+-${eps}), obtuve ${actual}`)
}

function fixtureSession(): StudioSession {
  return parseSession(structuredClone(sessionFixtureV2))
}

function on(pitch: number, ctxTime: number, extra: Partial<MidiNoteEvent> = {}): MidiNoteEvent {
  return { type: 'on', pitch, velocity: 100, channel: 0, ctxTime, source: 'midi', ...extra }
}

function off(pitch: number, ctxTime: number, extra: Partial<MidiNoteEvent> = {}): MidiNoteEvent {
  return { type: 'off', pitch, velocity: 0, channel: 0, ctxTime, source: 'midi', ...extra }
}

/** bpm 120: un beat = 0.5 s. La toma arranca en el segundo 10 del contexto, posicion 0. */
function takeOptions(extra: Partial<MidiTakeOptions> = {}): MidiTakeOptions {
  return {
    trackId: 'trk_2',
    playStart: { positionAtStart: 0, playStartCtxTime: 10 },
    bpm: 120,
    channel: 'all',
    quantize: null,
    stopCtxTime: 20,
    beatsPerBar: 4,
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// Worker simulado para studioCloud y jobs
// ---------------------------------------------------------------------------

interface Call {
  method: string
  url: string
  body: string | null
}

function fakeCloud(handler: (call: Call) => Response | Promise<Response>): { target: CloudTarget; calls: Call[] } {
  const calls: Call[] = []
  const target: CloudTarget = {
    baseUrl: 'https://stems.example.test',
    band: 'band_1',
    getToken: async () => 'tok-ok',
    fetchFn: async (input: string, init?: RequestInit) => {
      const call = { method: init?.method ?? 'GET', url: input, body: typeof init?.body === 'string' ? init.body : null }
      calls.push(call)
      return handler(call)
    },
  }
  return { target, calls }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function memoryStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } {
  const map = new Map<string, string>()
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) }
}

const VIEW: ChatView = { playheadBeat: 16, selection: { trackId: 'trk_2', clipIds: ['mid_p1'], context: 'timeline' } }

function chatRequest(messages: StudioChatMessage[], session = fixtureSession()): ChatJobRequest {
  return { kind: 'chat', messages, sessionSummary: buildSessionSummary(session, VIEW), toolMode: 'auto' }
}

function composeRequest(extra: Partial<ComposeJobRequest> = {}): ComposeJobRequest {
  return { kind: 'compose', prompt: 'Bajo con groove', bpm: 120, key: 'C#m', beatsPerBar: 4, lengthBars: 4, role: 'bass', context: [], ...extra }
}

async function main() {
  console.log('midiInput.ts: mensajes, reloj y tomas')

  await check('parseMidiMessage: note-on, note-off, note-on con velocidad 0 y lo que no es nota', () => {
    assert.deepEqual(parseMidiMessage([0x93, 60, 100]), { type: 'on', channel: 3, pitch: 60, velocity: 100 })
    assert.deepEqual(parseMidiMessage([0x80, 61, 40]), { type: 'off', channel: 0, pitch: 61, velocity: 40 })
    assert.deepEqual(parseMidiMessage(new Uint8Array([0x9f, 62, 0])), { type: 'off', channel: 15, pitch: 62, velocity: 0 })
    assert.equal(parseMidiMessage([0xb0, 7, 100]), null, 'control change')
    assert.equal(parseMidiMessage([0xe0, 0, 64]), null, 'pitch bend')
    assert.equal(parseMidiMessage([0x90, 60]), null, 'mensaje cortado')
    assert.equal(parseMidiMessage(null), null)
  })

  await check('performanceToCtxTime y clockStamp: getOutputTimestamp y su respaldo con latencias', () => {
    close(performanceToCtxTime(5250, { contextTime: 10, performanceTime: 5000 }), 10.25)
    close(performanceToCtxTime(4900, { contextTime: 10, performanceTime: 5000 }), 9.9)
    assert.deepEqual(clockStamp({ currentTime: 3, getOutputTimestamp: () => ({ contextTime: 2.9, performanceTime: 1234 }) }, 9999), { contextTime: 2.9, performanceTime: 1234 })
    // Contexto suspendido: getOutputTimestamp devuelve ceros -> currentTime menos latencias.
    const fallback = clockStamp({ currentTime: 3, baseLatency: 0.01, outputLatency: 0.04, getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }) }, 777)
    close(fallback.contextTime, 2.95)
    assert.equal(fallback.performanceTime, 777)
    close(clockStamp({ currentTime: 1 }, 5).contextTime, 1)
  })

  await check('computerKeyPitch (reexportado de computerKeyboard.ts): fila A..K desde el Do central', () => {
    assert.equal(computerKeyPitch('KeyA', 4), 60)
    assert.equal(computerKeyPitch('KeyW', 4), 61)
    assert.equal(computerKeyPitch('KeyK', 4), 72)
    assert.equal(computerKeyPitch('KeyA', 5), 72)
    assert.equal(computerKeyPitch('KeyQ', 4), null)
  })

  await check('eventsToTake: toma basica, clip alineado al compas, notas relativas al clip', () => {
    const take = eventsToTake([on(60, 10), off(60, 10.5), on(62, 11), off(62, 11.25)], takeOptions())
    assert.ok(take)
    assert.equal(take.trackId, 'trk_2')
    assert.equal(take.startBeat, 0)
    assert.equal(take.lengthBeats, 4)
    assert.equal(take.hangingNotes, 0)
    assert.deepEqual(take.notes, [
      { pitch: 60, start: 0, length: 1, velocity: 100 },
      { pitch: 62, start: 2, length: 0.5, velocity: 100 },
    ])
  })

  await check('eventsToTake: el conteo se descarta y una nota apenas adelantada cae en el beat de arranque', () => {
    const take = eventsToTake([on(50, 9), off(50, 9.4), on(60, 10 - MIDI_EARLY_TOLERANCE_S / 2), off(60, 10.5)], takeOptions())
    assert.ok(take)
    assert.equal(take.notes.length, 1)
    assert.equal(take.notes[0].pitch, 60)
    assert.equal(take.notes[0].start, 0)
  })

  await check('eventsToTake: arranque a mitad de la sesion (positionAtStart) y compas de inicio', () => {
    // posicion 8 s = beat 16; la nota llega 2 beats despues (beat 18) -> clip desde el compas del beat 16.
    const take = eventsToTake([on(64, 11), off(64, 11.5)], takeOptions({ playStart: { positionAtStart: 8, playStartCtxTime: 10 } }))
    assert.ok(take)
    assert.equal(take.startBeat, 16)
    assert.equal(take.lengthBeats, 4)
    assert.deepEqual(take.notes, [{ pitch: 64, start: 2, length: 1, velocity: 100 }])
  })

  await check('eventsToTake: nota colgada al parar, nota repetida y note-off huerfano', () => {
    const take = eventsToTake([off(70, 10.1), on(60, 10), on(60, 10.25), on(67, 11)], takeOptions({ stopCtxTime: 12 }))
    assert.ok(take)
    assert.equal(take.hangingNotes, 2)
    const c4 = take.notes.filter((n) => n.pitch === 60)
    assert.deepEqual(c4.map((n) => [n.start, n.length]), [[0, 0.5], [0.5, 3.5]])
    assert.deepEqual(take.notes.find((n) => n.pitch === 67), { pitch: 67, start: 2, length: 2, velocity: 100 })
    assert.equal(take.notes.some((n) => n.pitch === 70), false)
  })

  await check('eventsToTake: filtro de canal (el teclado de la computadora siempre entra)', () => {
    const take = eventsToTake(
      [on(60, 10, { channel: 0 }), off(60, 10.5, { channel: 0 }), on(62, 10, { channel: 2 }), off(62, 10.5, { channel: 2 }), on(64, 10, { source: 'keyboard' }), off(64, 10.5, { source: 'keyboard' })],
      takeOptions({ channel: 2 }),
    )
    assert.ok(take)
    assert.deepEqual(take.notes.map((n) => n.pitch), [62, 64])
  })

  await check('eventsToTake: con loop las vueltas se superponen en la region', () => {
    const take = eventsToTake([on(60, 10.5), off(60, 11), on(64, 12.5), off(64, 13)], takeOptions({ loop: { startBeat: 0, endBeat: 4 } }))
    assert.ok(take)
    assert.equal(take.startBeat, 0)
    assert.equal(take.lengthBeats, 4)
    assert.deepEqual(take.notes.map((n) => [n.pitch, n.start]), [[60, 1], [64, 1]])
  })

  await check('eventsToTake: cuantizar al terminar, sin notas = null y tope de fin de sesion', () => {
    const q = eventsToTake([on(60, 10.55), off(60, 11.05)], takeOptions({ quantize: { grid: '1/4', triplets: false, strength: 1 } }))
    assert.ok(q)
    close(q.notes[0].start, 1)
    assert.equal(eventsToTake([on(60, 5), off(60, 6)], takeOptions()), null, 'solo conteo')
    assert.equal(eventsToTake([], takeOptions()), null)
    // A 60 BPM la sesion termina en el beat 1200: el clip no pasa de ahi.
    const late = eventsToTake([on(60, 10 + 1198.5), off(60, 10 + 1199.9)], takeOptions({ bpm: 60, stopCtxTime: 1300 }))
    assert.ok(late)
    assert.ok(late.startBeat + late.lengthBeats <= 1200)
  })

  await check('isTextFieldTarget: campos de texto si, casillas y elementos comunes no', () => {
    assert.equal(isTextFieldTarget({ tagName: 'INPUT', type: 'text' } as unknown as EventTarget), true)
    assert.equal(isTextFieldTarget({ tagName: 'input', type: 'search' } as unknown as EventTarget), true)
    assert.equal(isTextFieldTarget({ tagName: 'INPUT', type: 'checkbox' } as unknown as EventTarget), false)
    assert.equal(isTextFieldTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget), true)
    assert.equal(isTextFieldTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget), true)
    assert.equal(isTextFieldTarget({ tagName: 'BUTTON' } as unknown as EventTarget), false)
    assert.equal(isTextFieldTarget(null), false)
  })

  console.log('midiInput.ts: clase con Web MIDI simulado')

  type MessageListener = (event: { data?: ArrayLike<number> | null; timeStamp?: number }) => void
  type StateListener = (event: { port?: { id: string; type?: string; state?: string } | null }) => void
  function fakePort(id: string, name: string): MidiInputPortLike & { listeners: Set<MessageListener>; send(data: number[], timeStamp: number): void; state: string } {
    const listeners = new Set<MessageListener>()
    return {
      id,
      name,
      manufacturer: 'Prueba',
      state: 'connected',
      type: 'input',
      listeners,
      addEventListener: (_t, l) => void listeners.add(l),
      removeEventListener: (_t, l) => void listeners.delete(l),
      send(data, timeStamp) {
        for (const l of [...listeners]) l({ data, timeStamp })
      },
    }
  }
  function fakeAccess(ports: Array<ReturnType<typeof fakePort>>): MidiAccessLike & { stateListeners: Set<StateListener>; ports: Map<string, ReturnType<typeof fakePort>> } {
    const map = new Map(ports.map((p) => [p.id, p]))
    const stateListeners = new Set<StateListener>()
    return {
      ports: map,
      stateListeners,
      inputs: { values: () => map.values(), get: (id: string) => map.get(id) },
      addEventListener: (_t, l) => void stateListeners.add(l),
      removeEventListener: (_t, l) => void stateListeners.delete(l),
    }
  }
  // Reloj del contexto: contextTime 10 en performanceTime 5000.
  const ctx = { currentTime: 10.1, getOutputTimestamp: () => ({ contextTime: 10, performanceTime: 5000 }) }

  await check('StudioMidiInput: acceso, lista, abrir, notas con su tiempo del contexto, toma y cierre', async () => {
    const port = fakePort('in-1', 'Teclado USB')
    const access = fakeAccess([port])
    let requested: unknown = null
    const input = new StudioMidiInput({
      getContext: () => ctx,
      navigator: {
        requestMIDIAccess: async (options) => {
          requested = options
          return access
        },
      },
      now: () => 5000,
      keyboardTarget: new EventTarget(),
    })
    assert.equal(input.isSupported(), true)
    assert.equal(await input.requestAccess(), 'granted')
    assert.deepEqual(requested, { sysex: false })
    assert.deepEqual(input.listInputs(), [{ id: 'in-1', name: 'Teclado USB', manufacturer: 'Prueba', connected: true }])
    const seen: MidiNoteEvent[] = []
    input.onNote((e) => seen.push(e))
    input.open('in-1', 'all')
    input.startRecording({ trackId: 'trk_2', playStart: { positionAtStart: 0, playStartCtxTime: 10 }, bpm: 120, channel: 'all', quantize: null, beatsPerBar: 4 })
    port.send([0x90, 60, 90], 5000)
    port.send([0x80, 60, 0], 5500)
    port.send([0xb0, 1, 5], 5600)
    assert.equal(seen.length, 2)
    close(seen[0].ctxTime, 10)
    close(seen[1].ctxTime, 10.5)
    assert.equal(seen[0].source, 'midi')
    const take = input.stopRecording(12)
    assert.ok(take)
    assert.deepEqual(take.notes, [{ pitch: 60, start: 0, length: 1, velocity: 90 }])
    assert.equal(input.isRecording(), false)
    assert.throws(() => input.open('no-existe', 'all'), /no está conectado/)
    input.close()
    input.close()
    assert.equal(port.listeners.size, 0, 'al cerrar suelta el puerto')
    assert.equal(access.stateListeners.size, 0)
  })

  await check('StudioMidiInput: canal del dispositivo, conexion en caliente, negado y sin soporte', async () => {
    const port = fakePort('in-1', 'Teclado USB')
    const access = fakeAccess([port])
    const input = new StudioMidiInput({ getContext: () => ctx, navigator: { requestMIDIAccess: async () => access }, now: () => 5000, keyboardTarget: new EventTarget() })
    await input.requestAccess()
    const seen: MidiNoteEvent[] = []
    input.onNote((e) => seen.push(e))
    const lists: number[] = []
    input.onDevicesChange((d) => lists.push(d.length))
    input.open('in-1', 1)
    port.send([0x90, 60, 90], 5000)
    port.send([0x91, 62, 90], 5000)
    assert.deepEqual(seen.map((e) => e.pitch), [62], 'solo el canal 2 (indice 1)')
    // Se desconecta y vuelve como otro objeto con el mismo id: se engancha solo.
    const again = fakePort('in-1', 'Teclado USB')
    access.ports.set('in-1', again)
    for (const l of access.stateListeners) l({ port: { id: 'in-1', type: 'input', state: 'connected' } })
    again.send([0x91, 64, 90], 5000)
    assert.deepEqual(seen.map((e) => e.pitch), [62, 64])
    assert.equal(port.listeners.size, 0)
    assert.deepEqual(lists, [1])
    input.close()

    const denied = new StudioMidiInput({ getContext: () => ctx, navigator: { requestMIDIAccess: () => Promise.reject(new Error('SecurityError')) }, keyboardTarget: new EventTarget() })
    assert.equal(await denied.requestAccess(), 'denied')
    const none = new StudioMidiInput({ getContext: () => ctx, navigator: {}, keyboardTarget: new EventTarget() })
    assert.equal(none.isSupported(), false)
    assert.equal(await none.requestAccess(), 'unsupported')
    assert.equal(await none.queryAccess(), 'unsupported')
  })

  await check('StudioMidiInput: teclado de la computadora (notas, octava, modificadores, soltar al perder foco)', async () => {
    const target = new EventTarget()
    const input = new StudioMidiInput({ getContext: () => ctx, navigator: {}, now: () => 5000, keyboardTarget: target })
    const seen: MidiNoteEvent[] = []
    input.onNote((e) => seen.push(e))
    input.setComputerKeyboard(true)
    const key = (type: string, code: string, extra: Record<string, unknown> = {}) => {
      const event = new Event(type, { cancelable: true })
      for (const [k, v] of Object.entries({ code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra })) {
        Object.defineProperty(event, k, { value: v })
      }
      target.dispatchEvent(event)
      return event
    }
    const down = key('keydown', 'KeyA')
    assert.equal(down.defaultPrevented, true, 'la tecla musical no llega a los atajos')
    key('keydown', 'KeyA', { repeat: true })
    key('keyup', 'KeyA')
    key('keydown', 'KeyX')
    key('keydown', 'KeyA')
    const ctrl = key('keydown', 'KeyS', { ctrlKey: true })
    assert.equal(ctrl.defaultPrevented, false, 'Ctrl+S sigue siendo un atajo')
    target.dispatchEvent(new Event('blur'))
    assert.deepEqual(
      seen.map((e) => `${e.type}:${e.pitch}:${e.source}`),
      ['on:60:keyboard', 'off:60:keyboard', 'on:72:keyboard', 'off:72:keyboard'],
    )
    assert.equal(input.getComputerKeyboardOctave(), 5)
    input.setComputerKeyboard(false)
    key('keydown', 'KeyD')
    assert.equal(seen.length, 4, 'apagado no toca notas')
    input.close()
  })

  console.log('audioToMidi.ts: conversion de eventos (sin el modelo)')

  await check('amplitudeToVelocity y minNoteFrames', () => {
    assert.equal(amplitudeToVelocity(0), 1)
    assert.equal(amplitudeToVelocity(1), 127)
    assert.equal(amplitudeToVelocity(0.5), 64)
    assert.equal(amplitudeToVelocity(Number.NaN), 1)
    assert.equal(minNoteFrames(60), 5)
    assert.equal(minNoteFrames(0), 5)
    assert.equal(minNoteFrames(1), 1)
  })

  await check('noteEventsToStudioNotes: segundos a beats, filtros y normalizacion', () => {
    const notes = noteEventsToStudioNotes(
      [
        { startTimeSeconds: 0.5, durationSeconds: 0.5, pitchMidi: 60, amplitude: 0.5 },
        { startTimeSeconds: 0.75, durationSeconds: 0.5, pitchMidi: 60, amplitude: 0.5 },
        { startTimeSeconds: 1, durationSeconds: 0.03, pitchMidi: 64, amplitude: 1 },
        { startTimeSeconds: 1, durationSeconds: 0.5, pitchMidi: 20, amplitude: 1 },
        { startTimeSeconds: 9, durationSeconds: 0.5, pitchMidi: 62, amplitude: 1 },
        { startTimeSeconds: 2, durationSeconds: 0.25, pitchMidi: 67, amplitude: 1 },
      ],
      { bpm: 120, durationS: 4, lowPitch: 36, highPitch: 96 },
    )
    assert.deepEqual(notes, [
      { pitch: 60, start: 1, length: 0.5, velocity: 64 },
      { pitch: 60, start: 1.5, length: 1, velocity: 64 },
      { pitch: 67, start: 4, length: 0.5, velocity: 127 },
    ])
    assert.deepEqual(noteEventsToStudioNotes([{ startTimeSeconds: 0, durationSeconds: 1, pitchMidi: 60, amplitude: 1 }], { bpm: 0, durationS: 1 }), [])
  })

  await check('availability y transcribe sin navegador: no disponible, con motivo', async () => {
    const state = availability()
    assert.equal(state.available, false)
    assert.ok(state.reason && /navegador/.test(state.reason))
    assert.equal(state.license, 'Apache-2.0')
    await assert.rejects(transcribe({ duration: 1 } as AudioBuffer, { bpm: 120 }), /navegador/)
  })

  console.log('studioCloud.ts: trabajos compose, analyze y chat')

  const call1: StudioChatToolCall = { id: 'call_1', name: 'set_track_mix', arguments: { track_id: 'trk_1', volume_db: -3, extraCamel: { keepMe: true } }, signature: 'firma-opaca==' }

  await check('jobRequestV2ToWire: compose, analyze y chat en snake_case; llamadas y firmas intactas', () => {
    const compose = jobRequestV2ToWire(composeRequest({ context: [{ role: 'drums', name: 'Bateria', notes: [{ pitch: 36, start: 0, length: 0.25, velocity: 110 }] }] }))
    assert.deepEqual(compose, {
      kind: 'compose',
      prompt: 'Bajo con groove',
      bpm: 120,
      key: 'C#m',
      beats_per_bar: 4,
      length_bars: 4,
      role: 'bass',
      context: [{ role: 'drums', name: 'Bateria', notes: [{ pitch: 36, start: 0, length: 0.25, velocity: 110 }] }],
    })
    assert.deepEqual(jobRequestV2ToWire({ kind: 'analyze', assetId: 'ast_1', durationS: 30 }), { kind: 'analyze', asset_id: 'ast_1', duration_s: 30 })
    const messages: StudioChatMessage[] = [
      { role: 'user', text: 'Baja la voz' },
      { role: 'model', text: null, toolCalls: [call1] },
      { role: 'tool', toolResults: [{ callId: 'call_1', name: 'set_track_mix', response: { status: 'applied', message: 'ok' } }] },
    ]
    const wire = jobRequestV2ToWire({ ...chatRequest(messages), toolMode: undefined }) as { messages: unknown[]; tool_mode: string; session_summary: Record<string, unknown> }
    assert.deepEqual(wire.messages[1], { role: 'model', text: null, tool_calls: [{ id: 'call_1', name: 'set_track_mix', arguments: { track_id: 'trk_1', volume_db: -3, extraCamel: { keepMe: true } }, signature: 'firma-opaca==' }] })
    assert.deepEqual(wire.messages[2], { role: 'tool', tool_results: [{ call_id: 'call_1', name: 'set_track_mix', response: { status: 'applied', message: 'ok' } }] })
    assert.equal(wire.tool_mode, 'auto')
    // El fixture trae acordes guardados: `chords` (opcional, 4.3.2) va antes de master.
    assert.deepEqual(Object.keys(wire.session_summary), ['title', 'bpm', 'beats_per_bar', 'key', 'length_s', 'playhead_beat', 'selection', 'tracks', 'markers', 'chords', 'master'])
    const v1 = jobRequestV2ToWire({ kind: 'separate', assetId: 'ast_1', durationS: 10 })
    assert.deepEqual(v1, { kind: 'separate', asset_id: 'ast_1', duration_s: 10 })
  })

  await check('sessionSummaryToWire: pista de instrumento y clips MIDI con sus claves', () => {
    const wire = sessionSummaryToWire(buildSessionSummary(fixtureSession(), VIEW)) as { tracks: Array<Record<string, unknown>>; master: Record<string, unknown> }
    const pad = wire.tracks.find((t) => t.id === 'trk_2')
    assert.ok(pad)
    assert.deepEqual(pad.instrument, { type: 'synth', preset: 'pad_calido', plugin_id: null })
    const [padClip] = pad.midi_clips as Array<Record<string, unknown>>
    const { digest, ...padClipRest } = padClip
    assert.deepEqual(padClipRest, { id: 'mid_p1', start_beat: 16, length_beats: 16, loop: false, note_count: 6, pitch_min: 57, pitch_max: 68 })
    assert.deepEqual(Object.keys(digest as object), ['span_beats', 'pitch_classes', 'notes_per_bar', 'grid', 'velocity_mean', 'notes'])
    assert.equal(((digest as { notes: unknown[] }).notes).length, 6, 'clip corto: van las notas literales')
    assert.deepEqual(Object.keys(pad), ['id', 'kind', 'name', 'role', 'volume_db', 'pan', 'mute', 'solo', 'reverb_send_db', 'fx', 'instrument', 'clips', 'midi_clips'])
    assert.deepEqual(Object.keys(wire.master.reverb as object), ['decay_s', 'return_db'])
    const voz = wire.tracks.find((t) => t.id === 'trk_1')
    assert.deepEqual(voz?.instrument, null)
    assert.deepEqual((voz?.clips as unknown[])[0], { id: 'clp_1', start_s: 8, length_s: 20, active: true })
  })

  await check('parseJobStateV2: compose descarta notas invalidas; analyze defensivo; v1 delegado', () => {
    const compose = parseJobStateV2(
      { job_id: 'job_c', kind: 'compose', status: 'SUCCEEDED', notes: [{ pitch: 40, start: 0, length: 1, velocity: 100 }, { pitch: 200, start: 0, length: 1, velocity: 100 }], length_beats: 16, description: ' Bajo ', cost_usd: 0.05 },
      'job_c',
    )
    assert.deepEqual(compose, { status: 'SUCCEEDED', jobId: 'job_c', kind: 'compose', notes: [{ pitch: 40, start: 0, length: 1, velocity: 100 }], lengthBeats: 16, description: 'Bajo', costUsd: 0.05 })
    assert.throws(() => parseJobStateV2({ kind: 'compose', status: 'SUCCEEDED', notes: [], length_beats: 0 }, 'job_c'), (e: unknown) => e instanceof StemCloudError && e.code === 'bad_response')
    const analyze = parseJobStateV2(
      {
        kind: 'analyze',
        status: 'SUCCEEDED',
        analysis: {
          bpm: 300,
          key: 'Am',
          beats_per_bar: 3,
          downbeat_s: 0.4,
          markers: [{ time_s: 1, label: 'Coro'.repeat(30), kind: 'chorus' }, { time_s: 5, label: 'x', kind: 'raro' }, { time_s: -1, label: 'mal', kind: 'verse' }],
          chords: [{ start_s: 0, end_s: 1, name: 'Am' }, { start_s: 2, end_s: 1, name: 'C' }, { start_s: 3, end_s: 4, name: '' }],
        },
        cost_usd: 0.3,
      },
      'job_a',
    )
    assert.ok(analyze.status === 'SUCCEEDED' && analyze.kind === 'analyze')
    assert.equal(analyze.analysis.bpm, null)
    assert.equal(analyze.analysis.beatsPerBar, 3)
    assert.equal(analyze.analysis.downbeatS, 0.4)
    assert.deepEqual(analyze.analysis.markers.map((m) => [m.timeS, m.label.length, m.kind]), [[1, 60, 'chorus'], [5, 1, 'marker']])
    assert.deepEqual(analyze.analysis.chords, [{ startS: 0, endS: 1, name: 'Am' }])
    assert.deepEqual(parseJobStateV2({ kind: 'analyze', status: 'STARTED' }, 'job_a'), { status: 'STARTED', jobId: 'job_a', kind: 'analyze' })
    const assist = parseJobStateV2({ kind: 'assist', status: 'SUCCEEDED', suggestions: [], cost_usd: 0.05 }, 'job_s')
    assert.deepEqual(assist, { status: 'SUCCEEDED', jobId: 'job_s', kind: 'assist', suggestions: [], costUsd: 0.05 })
  })

  await check('parseJobStateV2 chat: todas las llamadas tal cual (nombre desconocido incluido); forma rota = bad_response', () => {
    const state = parseJobStateV2(
      {
        kind: 'chat',
        status: 'SUCCEEDED',
        reply: '  ',
        tool_calls: [
          { id: 'call_1', name: 'set_track_mix', arguments: { track_id: 'trk_1' }, signature: 'abc' },
          { id: 'call_2', name: 'herramienta_inventada', arguments: {}, signature: null },
        ],
        cost_usd: 0.03,
      },
      'job_t',
    )
    assert.ok(state.status === 'SUCCEEDED' && state.kind === 'chat')
    assert.equal(state.reply, null)
    assert.deepEqual(state.toolCalls.map((c) => [c.id, c.name, c.signature]), [['call_1', 'set_track_mix', 'abc'], ['call_2', 'herramienta_inventada', null]])
    const bad = (raw: unknown) => assert.throws(() => parseJobStateV2(raw, 'job_t'), (e: unknown) => e instanceof StemCloudError && e.code === 'bad_response')
    bad({ kind: 'chat', status: 'SUCCEEDED', reply: 'x', tool_calls: [{ id: 'mal', name: 'a', arguments: {} }] })
    bad({ kind: 'chat', status: 'SUCCEEDED', reply: 'x', tool_calls: [{ id: 'call_1', name: 'a', arguments: [] }] })
    bad({ kind: 'chat', status: 'SUCCEEDED', reply: 'x', tool_calls: [{ id: 'call_1', name: 'a', arguments: {} }, { id: 'call_1', name: 'b', arguments: {} }] })
    bad({ kind: 'chat', status: 'SUCCEEDED', reply: 'x', tool_calls: Array.from({ length: 17 }, (_, i) => ({ id: `call_${i + 1}`, name: 'a', arguments: {} })) })
    bad({ kind: 'desconocido', status: 'SUCCEEDED' })
  })

  await check('startJobV2, getJobV2, estimateJobV2 contra el Worker simulado; topes de cuerpo sin salir a la red', async () => {
    const { target, calls } = fakeCloud((call) => {
      if (call.method === 'POST' && call.url.includes('estimate=1')) return json(200, { estimated_cost_usd: 0.03, spent_usd: 1, budget_usd: 10, allowed: true })
      if (call.method === 'POST') return json(202, { job_id: 'job_x', status: 'STARTED' })
      return json(200, { job_id: 'job_x', kind: 'chat', status: 'SUCCEEDED', reply: 'Hecho', tool_calls: [], cost_usd: 0.03 })
    })
    const req = chatRequest([{ role: 'user', text: 'Hola' }])
    const started = await startJobV2(target, 'ses_1', req, 'job_x')
    assert.deepEqual(started, { status: 'STARTED', jobId: 'job_x', kind: 'chat' })
    assert.equal(calls[0].url, 'https://stems.example.test/v1/bands/band_1/studio/ses_1/jobs?job_id=job_x')
    assert.equal(JSON.parse(calls[0].body ?? '{}').kind, 'chat')
    const done = await getJobV2(target, 'ses_1', 'job_x')
    assert.ok(done.status === 'SUCCEEDED' && done.kind === 'chat' && done.reply === 'Hecho')
    const est = await estimateJobV2(target, 'ses_1', req)
    assert.deepEqual(est, { kind: 'chat', estimatedCostUsd: 0.03, spentUsd: 1, budgetUsd: 10, allowed: true, listen: false })
    const before = calls.length
    const huge = chatRequest([{ role: 'user', text: 'x'.repeat(STUDIO_CHAT_BODY_MAX_BYTES) }])
    await assert.rejects(startJobV2(target, 'ses_1', huge, 'job_y'), (e: unknown) => e instanceof StemCloudError && e.code === 'job_too_large')
    await assert.rejects(startJobV2(target, 'ses_1', composeRequest({ prompt: 'y'.repeat(70000) }), 'job_z'), (e: unknown) => e instanceof StemCloudError && e.code === 'job_too_large')
    assert.equal(calls.length, before, 'no salio a la red')
  })

  await check('watchJobV2: reintenta la red, sondea hasta terminar y respeta el tiempo limite', async () => {
    let n = 0
    const { target } = fakeCloud(() => {
      n++
      if (n === 1) throw new TypeError('fetch failed')
      if (n === 2) return json(200, { kind: 'analyze', status: 'STARTED' })
      return json(200, { kind: 'analyze', status: 'SUCCEEDED', analysis: { bpm: 98, key: null, beats_per_bar: 4, downbeat_s: null, markers: [], chords: [] }, cost_usd: 0.3 })
    })
    const states: string[] = []
    const result = await watchJobV2(target, 'ses_1', 'job_a', { sleep: async () => undefined, onState: (s) => states.push(s.status) })
    assert.ok(result && result.status === 'SUCCEEDED' && result.kind === 'analyze' && result.analysis.bpm === 98)
    assert.deepEqual(states, ['STARTED', 'SUCCEEDED'])
    let clock = 0
    const slow = fakeCloud(() => json(200, { kind: 'analyze', status: 'STARTED' }))
    const timedOut = await watchJobV2(slow.target, 'ses_1', 'job_a', { sleep: async () => void (clock += 1000), now: () => clock, timeoutMs: 2500 })
    assert.ok(timedOut && timedOut.status === 'FAILED' && timedOut.resumable === true && timedOut.kind === 'analyze')
  })

  console.log('jobs.ts: v2')

  await check('runJobV2: id elegido y avisado antes del POST; chat sin espera; analyze espera un intervalo', async () => {
    const log: string[] = []
    const { target } = fakeCloud((call) => {
      log.push(call.method)
      if (call.method === 'POST') return json(202, { job_id: 'job_fijo' })
      const kind = call.url.includes('job_fijo') ? (log.length > 2 ? 'analyze' : 'chat') : 'chat'
      return kind === 'chat'
        ? json(200, { kind: 'chat', status: 'SUCCEEDED', reply: 'Listo', tool_calls: [], cost_usd: 0.03 })
        : json(200, { kind: 'analyze', status: 'SUCCEEDED', analysis: { markers: [], chords: [] }, cost_usd: 0.3 })
    })
    let sleeps = 0
    const chat = await runJobV2(target, 'ses_1', chatRequest([{ role: 'user', text: 'Hola' }]), {
      newJobId: () => 'job_fijo',
      onStarted: (id) => log.push(`started:${id}`),
      sleep: async () => void sleeps++,
    })
    assert.ok(chat && chat.status === 'SUCCEEDED')
    assert.deepEqual(log.slice(0, 3), ['started:job_fijo', 'POST', 'GET'])
    assert.equal(sleeps, 0, 'chat se consulta sin esperar')
    const analyze = await runJobV2(target, 'ses_1', { kind: 'analyze', assetId: 'ast_1', durationS: 30 }, { newJobId: () => 'job_fijo', sleep: async () => void sleeps++ })
    assert.ok(analyze && analyze.status === 'SUCCEEDED')
    assert.equal(sleeps, 1)
    await assert.rejects(runJobV2(target, 'ses_1', composeRequest({ prompt: '  ' })), (e: unknown) => e instanceof StemCloudError && e.code === 'bad_job')
  })

  await check('runJobV2: si se pierde la respuesta del POST consulta el mismo id en vez de relanzar', async () => {
    let posts = 0
    const { target } = fakeCloud((call) => {
      if (call.method === 'POST') {
        posts++
        throw new TypeError('fetch failed')
      }
      return json(200, { kind: 'compose', status: 'SUCCEEDED', notes: [], length_beats: 16, description: 'nada', cost_usd: 0.05 })
    })
    const state = await runJobV2(target, 'ses_1', composeRequest(), { newJobId: () => 'job_perdido', sleep: async () => undefined })
    assert.ok(state && state.status === 'SUCCEEDED' && state.jobId === 'job_perdido')
    assert.equal(posts, 1)
  })

  await check('jobRequestProblemV2: compose y analyze', () => {
    assert.equal(jobRequestProblemV2(composeRequest()), null)
    assert.match(jobRequestProblemV2(composeRequest({ prompt: ' ' })) ?? '', /Escribe/)
    assert.match(jobRequestProblemV2(composeRequest({ lengthBars: 65 })) ?? '', /compases/)
    assert.match(jobRequestProblemV2(composeRequest({ role: 'voz' as never })) ?? '', /batería/)
    const many: StudioMidiNote[] = Array.from({ length: 200 }, (_, i) => ({ pitch: 60, start: i, length: 0.5, velocity: 90 }))
    const ctxTracks = [0, 1, 2].map((i) => ({ role: 'other' as const, name: `P${i}`, notes: many }))
    assert.match(jobRequestProblemV2(composeRequest({ context: ctxTracks })) ?? '', /512/)
    assert.match(jobRequestProblemV2(composeRequest({ context: [{ role: 'other', name: 'P', notes: [{ pitch: 60, start: 0, length: 0, velocity: 90 }] }] })) ?? '', /nota/)
    assert.equal(jobRequestProblemV2({ kind: 'analyze', assetId: 'ast_1', durationS: 30 }), null)
    assert.ok(jobRequestProblemV2({ kind: 'analyze', assetId: 'ast_1', durationS: 0 }))
    assert.ok(jobRequestProblemV2({ kind: 'analyze', assetId: 'mal id', durationS: 3 }))
  })

  await check('chatRequestProblem: forma de la conversacion (STUDIO_V2.md 4.3.1)', () => {
    const user: StudioChatMessage = { role: 'user', text: 'Hola' }
    const model: StudioChatMessage = { role: 'model', text: 'Va', toolCalls: [call1] }
    const tool: StudioChatMessage = { role: 'tool', toolResults: [{ callId: 'call_1', name: 'set_track_mix', response: { status: 'applied', message: 'ok' } }] }
    assert.equal(chatRequestProblem(chatRequest([user])), null)
    assert.equal(chatRequestProblem(chatRequest([user, model, tool])), null)
    assert.equal(chatRequestProblem(chatRequest([user, { role: 'model', text: 'Listo', toolCalls: [] }, user])), null)
    assert.ok(chatRequestProblem(chatRequest([model, tool])), 'empieza por el modelo')
    assert.ok(chatRequestProblem(chatRequest([user, model])), 'termina en el modelo')
    assert.ok(chatRequestProblem(chatRequest([user, model, user])), 'faltan resultados')
    assert.ok(chatRequestProblem(chatRequest([user, model, { role: 'tool', toolResults: [{ callId: 'call_9', name: 'set_track_mix', response: { status: 'applied', message: '' } }] }])), 'call_id distinto')
    assert.ok(chatRequestProblem(chatRequest([user, { role: 'model', text: null, toolCalls: [] }, user])), 'respuesta vacia')
    assert.ok(chatRequestProblem(chatRequest([user, tool])), 'resultado sin llamada')
    assert.ok(chatRequestProblem(chatRequest([{ role: 'user', text: 'x'.repeat(4001) }])))
    assert.ok(chatRequestProblem(chatRequest(Array.from({ length: 41 }, () => user))))
  })

  await check('chatToolMode: none despues de 8 vueltas seguidas con herramientas', () => {
    const user: StudioChatMessage = { role: 'user', text: 'Hola' }
    const round = (i: number): StudioChatMessage[] => [
      { role: 'model', text: null, toolCalls: [{ ...call1, id: `call_${i}` }] },
      { role: 'tool', toolResults: [{ callId: `call_${i}`, name: 'set_track_mix', response: { status: 'applied', message: '' } }] },
    ]
    const seven = [user, ...Array.from({ length: 7 }, (_, i) => round(i + 1)).flat()]
    assert.equal(chatToolMode(seven), 'auto')
    assert.equal(chatToolMode([...seven, ...round(8)]), 'none')
    assert.equal(chatToolMode([...seven, ...round(8), user]), 'auto')
  })

  await check('trimChatMessages y chatRequestForSession: 40 mensajes, 192 KB y corte en un mensaje del usuario', () => {
    const msgs: StudioChatMessage[] = []
    for (let i = 0; i < 30; i++) {
      msgs.push({ role: 'user', text: `Pregunta ${i} ${'x'.repeat(3900)}` })
      msgs.push({ role: 'model', text: `Respuesta ${i} ${'y'.repeat(3000)}`, toolCalls: [] })
    }
    msgs.push({ role: 'user', text: 'Ultima' })
    const trimmed = trimChatMessages(msgs)
    assert.ok(trimmed.length <= CHAT_MAX_MESSAGES)
    assert.equal(trimmed[0].role, 'user')
    assert.deepEqual(trimmed[trimmed.length - 1], { role: 'user', text: 'Ultima' })
    const req = chatRequestForSession(msgs, buildSessionSummary(fixtureSession(), VIEW))
    assert.equal(req.messages[0].role, 'user')
    assert.ok(new TextEncoder().encode(JSON.stringify(jobRequestV2ToWire(req))).length <= STUDIO_CHAT_BODY_MAX_BYTES)
    assert.equal(chatRequestProblem(req), null)
    assert.deepEqual(trimChatMessages(msgs, () => false), [{ role: 'user', text: 'Ultima' }])
  })

  await check('appendUserMessage, appendModelReply y appendToolResults arman el turno siguiente valido', () => {
    let msgs = appendUserMessage([], '  Sube el bajo  ')
    assert.deepEqual(msgs, [{ role: 'user', text: 'Sube el bajo' }])
    const state = parseJobStateV2({ kind: 'chat', status: 'SUCCEEDED', reply: 'Propongo esto', tool_calls: [{ id: 'call_1', name: 'set_track_mix', arguments: { track_id: 'trk_1', volume_db: 2 }, signature: 's1' }] }, 'job_c')
    assert.ok(state.status === 'SUCCEEDED' && state.kind === 'chat')
    msgs = appendModelReply(msgs, state)
    msgs = appendToolResults(msgs, [{ callId: 'call_1', name: 'set_track_mix', response: { status: 'rejected', message: 'no' } }])
    assert.equal(chatRequestProblem(chatRequest(msgs)), null)
    assert.equal((msgs[1] as { toolCalls: StudioChatToolCall[] }).toolCalls[0].signature, 's1')
  })

  await check('buildSessionSummary y fitSessionSummary: clips cercanos al cabezal y tope de 32 KB', () => {
    const session = fixtureSession()
    const summary = buildSessionSummary(session, VIEW)
    assert.equal(summary.tracks.length, 4)
    assert.equal(summary.markers.length, 3)
    assert.equal(summary.playheadBeat, 16)
    const sampler = summary.tracks.find((t) => t.id === 'trk_4')
    assert.deepEqual(sampler?.instrument, { type: 'sampler', preset: null, pluginId: null })
    // Una pista con 100 clips: se mandan los 64 mas cercanos al cabezal, en su orden.
    const audio = session.tracks[0]
    const clips = Array.from({ length: 100 }, (_, i) => ({ ...audio.clips[0], id: `clp_x${i}`, startS: i * 2, lengthS: 1 }))
    const big: StudioSession = { ...session, tracks: [{ ...audio, clips }, ...session.tracks.slice(1)] }
    const view: ChatView = { ...VIEW, playheadBeat: 200 } // 100 s
    const s2 = buildSessionSummary(big, view)
    const ids = s2.tracks[0].clips.map((c) => c.id)
    assert.equal(ids.length, 64)
    assert.ok(ids.includes('clp_x50') && !ids.includes('clp_x0'))
    assert.ok(s2.tracks[0].clips.every((c, i, a) => i === 0 || a[i - 1].startS < c.startS), 'en orden')
    // 16 pistas con 100 clips cada una no caben en 32 KB con 64 clips: fitSessionSummary baja.
    const huge: StudioSession = { ...big, tracks: Array.from({ length: 16 }, (_, t) => ({ ...audio, id: `trk_h${t}`, clips: clips.map((c) => ({ ...c, id: `${c.id}_${t}` })) })) }
    assert.ok(sessionSummaryBytes(buildSessionSummary(huge, view)) > CHAT_SUMMARY_MAX_BYTES)
    const fitted = fitSessionSummary(huge, view)
    assert.ok(sessionSummaryBytes(fitted) <= CHAT_SUMMARY_MAX_BYTES)
    assert.ok(fitted.tracks[0].clips.length > 0)
  })

  await check('soundingClipNotes: repeticion desplegada y recorte al final del clip', () => {
    const clip = { id: 'mid_l', startBeat: 4, lengthBeats: 7, loop: true, loopBeats: 2, notes: [{ pitch: 60, start: 0, length: 1, velocity: 90 }, { pitch: 62, start: 1.5, length: 1, velocity: 90 }, { pitch: 64, start: 2.5, length: 1, velocity: 90 }] }
    const notes = soundingClipNotes(clip, 0, 100)
    assert.deepEqual(notes.map((n) => [n.pitch, n.start, n.length]), [
      [60, 4, 1],
      [62, 5.5, 1],
      [60, 6, 1],
      [62, 7.5, 1],
      [60, 8, 1],
      [62, 9.5, 1],
      [60, 10, 1],
    ])
    assert.deepEqual(soundingClipNotes(clip, 8.5, 10).map((n) => n.start), [8, 9.5])
    assert.deepEqual(soundingClipNotes(clip, 9, 10).map((n) => n.start), [9.5], 'la nota que termina justo en 9 no suena en [9, 10)')
    assert.deepEqual(soundingClipNotes({ ...clip, loop: false }, 0, 100).map((n) => [n.pitch, n.start, n.length]), [[60, 4, 1], [62, 5.5, 1], [64, 6.5, 1]])
  })

  await check('composeRequestForSession: contexto de las pistas de instrumento, relativo al tramo', () => {
    const session = fixtureSession()
    const req = composeRequestForSession(session, { prompt: ' Una linea de bajo ', role: 'bass', lengthBars: 4, startBeat: 16 })
    assert.equal(req.prompt, 'Una linea de bajo')
    assert.equal(req.bpm, 120)
    assert.equal(req.key, 'C#m')
    assert.equal(req.lengthBars, 4)
    assert.deepEqual(req.context.map((t) => [t.name, t.role]), [['Pad', 'chords']])
    assert.ok(req.context[0].notes.every((n) => n.start >= 0 && n.start < 16))
    assert.equal(jobRequestProblemV2(req), null)
    const atZero = composeRequestForSession(session, { prompt: 'x', role: 'melody', lengthBars: 2, startBeat: 0, contextTrackIds: ['trk_3', 'trk_1'] })
    assert.deepEqual(atZero.context.map((t) => [t.name, t.role, t.notes.length]), [['Bateria', 'drums', 24]])
    assert.equal(composeRequestForSession(session, { prompt: 'x', role: 'drums', lengthBars: 999, startBeat: 0 }).lengthBars, 64)
  })

  await check('composeResultToClip: clip sin repeticion con las notas normalizadas', () => {
    const state = parseJobStateV2(
      { kind: 'compose', status: 'SUCCEEDED', notes: [{ pitch: 40, start: 0, length: 2, velocity: 100 }, { pitch: 40, start: 1, length: 1, velocity: 90 }, { pitch: 43, start: 7.5, length: 2, velocity: 80 }], length_beats: 8, description: 'Bajo', cost_usd: 0.05 },
      'job_c',
    )
    assert.ok(state.status === 'SUCCEEDED' && state.kind === 'compose')
    const clip = composeResultToClip(state, { clipId: 'mid_nuevo', startBeat: 32 })
    assert.equal(clip.id, 'mid_nuevo')
    assert.equal(clip.startBeat, 32)
    assert.equal(clip.lengthBeats, 8)
    assert.equal(clip.loop, false)
    assert.equal(clip.loopBeats, 8)
    assert.deepEqual(clip.notes.filter((n) => n.pitch === 40).map((n) => [n.start, n.length]), [[0, 1], [1, 1]])
  })

  await check('analysisToMarkers y analysisSessionPatch: segundos del audio a beats de la sesion', () => {
    const analysis = {
      bpm: 98,
      key: 'Am',
      beatsPerBar: 4,
      downbeatS: null,
      markers: [
        { timeS: 12, label: 'Coro', kind: 'chorus' as const },
        { timeS: 2, label: 'Intro', kind: 'intro' as const },
        { timeS: 1, label: 'Antes del clip', kind: 'marker' as const },
        { timeS: 40, label: 'Despues del clip', kind: 'outro' as const },
      ],
      chords: [],
    }
    let n = 0
    const markers = analysisToMarkers(analysis, { clipStartS: 10, clipOffsetS: 2, clipLengthS: 30, bpm: 120 }, () => `mk_${++n}`)
    assert.deepEqual(markers, [
      { id: 'mk_2', beat: 20, label: 'Intro', kind: 'intro' },
      { id: 'mk_1', beat: 40, label: 'Coro', kind: 'chorus' },
    ])
    const session = fixtureSession()
    assert.deepEqual(analysisSessionPatch(session, analysis), { bpm: 98, key: 'Am' })
    assert.deepEqual(analysisSessionPatch(session, { ...analysis, bpm: 120, key: 'C#m' }), {})
  })

  await check('jobStatusTextV2 y trabajos pendientes v2 (guardar y leer)', () => {
    const s = (state: StudioJobStateV2) => jobStatusTextV2(state)
    assert.equal(s({ status: 'STARTED', jobId: 'job_1', kind: 'chat' }), 'EL ASISTENTE ESTÁ PENSANDO...')
    assert.equal(s({ status: 'SUCCEEDED', jobId: 'job_1', kind: 'compose', notes: [], lengthBeats: 4, description: '', costUsd: null }), 'LISTO: SIN NOTAS')
    assert.equal(s({ status: 'SUCCEEDED', jobId: 'job_1', kind: 'chat', reply: null, toolCalls: [call1, { ...call1, id: 'call_2' }], costUsd: null }), 'LISTO: 2 CAMBIOS PROPUESTOS')
    assert.equal(s({ status: 'FAILED', jobId: 'job_1', kind: 'analyze', error: 'x' }), 'EL ANÁLISIS FALLÓ')
    assert.equal(s({ status: 'SUCCEEDED', jobId: 'job_1', kind: 'assist', suggestions: [], costUsd: null }), 'LISTO: SIN CAMBIOS PROPUESTOS')
    const storage = memoryStorage()
    const request = composeRequest()
    writePendingJob(storage, 'ses_1', { jobId: 'job_abc', kind: 'compose', request, context: { startBeat: 8 }, at: 5 })
    assert.deepEqual(readPendingJobV2(storage, 'ses_1', 'compose'), { jobId: 'job_abc', kind: 'compose', request, context: { startBeat: 8 }, at: 5 })
    assert.equal(readPendingJobV2(storage, 'ses_1', 'chat'), null)
  })

  console.log('assistantTools.ts: lista cerrada, validacion y comandos pendientes')

  await check('STUDIO_ASSISTANT_TOOLS es identica a fixtures/studio_chat_tools_v2.json', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(STUDIO_ASSISTANT_TOOLS)), chatToolsFixture.tools)
    assert.equal(STUDIO_ASSISTANT_TOOLS.length, 19)
  })

  await check('cada herramienta tiene en commands.ts un comando con assistantTool y el mismo command_id', () => {
    for (const tool of STUDIO_ASSISTANT_TOOLS) {
      const spec = STUDIO_COMMAND_SPECS.find((c) => c.assistantTool === tool.name)
      assert.ok(spec, `sin comando para ${tool.name}`)
      assert.equal(spec.id, tool.command_id, tool.name)
      assert.equal(spec.assistantAllowed, true)
    }
  })

  await check('checkToolArguments: acota numeros, redondea enteros, ignora campos desconocidos y rechaza lo invalido', () => {
    const mix = checkToolArguments('set_track_mix', { track_id: 'trk_1', volume_db: 20, pan: -3, inventado: 1, solo: null })
    assert.equal(mix.ok, true)
    assert.deepEqual(mix.args, { track_id: 'trk_1', volume_db: 12, pan: -1 })
    assert.deepEqual(mix.adjusted, ['volume_db', 'pan'])
    assert.deepEqual(mix.ignored, ['inventado'])
    const tr = checkToolArguments('transpose_midi_clip', { clip_id: 'mid_p1', semitones: 2.6 })
    assert.deepEqual(tr.args, { clip_id: 'mid_p1', semitones: 3 })
    assert.match(checkToolArguments('transpose_midi_clip', { clip_id: 'mid_p1' }).error ?? '', /Falta el campo "semitones"/)
    assert.match(checkToolArguments('set_track_mix', { track_id: 'trk_1', volume_db: 'alto' }).error ?? '', /número/)
    assert.match(checkToolArguments('quantize_midi_clip', { clip_id: 'mid_p1', grid: '1/3' }).error ?? '', /no admite/)
    assert.match(checkToolArguments('add_audio_track', { name: '  ' }).error ?? '', /vacío/)
    const notes = checkToolArguments('replace_midi_notes', { clip_id: 'mid_p1', notes: [{ pitch: 130, start: 0, length: 1, velocity: 0 }] })
    assert.deepEqual(notes.args.notes, [{ pitch: 127, start: 0, length: 1, velocity: 1 }])
    assert.deepEqual(notes.adjusted, ['notes[0].pitch', 'notes[0].velocity'])
    assert.match(checkToolArguments('replace_midi_notes', { clip_id: 'mid_p1', notes: [{ pitch: 60, start: 0, length: 1 }] }).error ?? '', /notes\[0\]\.velocity/)
    assert.match(checkToolArguments('replace_midi_notes', { clip_id: 'mid_p1', notes: Array.from({ length: 1025 }, () => ({ pitch: 60, start: 0, length: 1, velocity: 1 })) }).error ?? '', /1024/)
    const inst = checkToolArguments('set_instrument', { track_id: 'trk_2', params: { filter_cutoff_hz: 900, raro: 'x' } })
    assert.deepEqual(inst.args, { track_id: 'trk_2', params: { filter_cutoff_hz: 900, raro: 'x' } })
    assert.equal(checkToolArguments('no_existe', {}).ok, false)
    assert.equal(checkToolArguments('set_master', null).ok, true, 'sin argumentos = objeto vacio')
  })

  await check('describeToolCall y beatPositionText: textos en espanol', () => {
    const session = fixtureSession()
    assert.equal(beatPositionText(16, 4), 'compás 5')
    assert.equal(beatPositionText(17, 4), 'compás 5, tiempo 2')
    assert.equal(beatPositionText(17.5, 4), 'compás 5, tiempo 2,5')
    assert.equal(describeToolCall('set_session_meta', { bpm: 96, key: 'Am' }, session), 'Cambiar el tempo a 96 BPM y la tonalidad a Am')
    assert.equal(describeToolCall('move_clip', { clip_id: 'mid_p1', start_beat: 32, track_id: 'trk_4' }, session), 'Mover el clip MIDI de "Pad" al compás 9 y pasarlo a "Piano muestreado"')
    assert.equal(describeToolCall('transpose_midi_clip', { clip_id: 'mid_p1', semitones: 12 }, session), 'Transponer el clip MIDI de "Pad" una octava arriba')
    assert.equal(describeToolCall('set_track_mix', { track_id: 'trk_1', volume_db: -3, pan: -0.3 }, session), 'Pista "Voz": fader a -3 dB y paneo 30 % a la izquierda')
    assert.equal(describeToolCall('add_instrument_track', { name: 'Bajo', instrument_type: 'synth', preset: 'bajo_sub' }, session), 'Agregar la pista de instrumento "Bajo": sintetizador, preset Bajo sub')
    assert.equal(describeToolCall('remove_marker', { marker_id: 'mk_2' }, session).startsWith('Quitar la marca "'), true)
    assert.match(describeToolCall('add_midi_clip', { track_id: 'trk_3', start_beat: 8, length_beats: 8, notes: [{}, {}] }, session), /2 notas en "Bateria", compás 3, largo 2 compases/)
  })

  await check('prepareToolCalls, applyPendingCommand, rejectPendingCommand y toolResultsMessage con el registro real', async () => {
    const session = fixtureSession()
    type Ctx = { session: StudioSession }
    const ran: Array<[string, unknown]> = []
    const registry = createCommandRegistry<Ctx>()
    for (const spec of STUDIO_COMMAND_SPECS) {
      if (!spec.assistantAllowed || spec.assistantTool === 'remove_track') continue
      registry.register({
        ...spec,
        run: (_ctx, args) => {
          if (spec.id === 'clip.set_gain') throw new Error('El clip quedó sin audio.')
          ran.push([spec.id, args])
        },
      })
    }
    const calls: StudioChatToolCall[] = [
      { id: 'call_1', name: 'set_track_mix', arguments: { track_id: 'trk_1', volume_db: 30 }, signature: 's' },
      { id: 'call_2', name: 'borrar_todo', arguments: {}, signature: null },
      { id: 'call_3', name: 'add_midi_clip', arguments: { track_id: 'trk_1', start_beat: 0, length_beats: 4, notes: [] }, signature: null },
      { id: 'call_4', name: 'set_track_mix', arguments: { track_id: 'trk_9' }, signature: null },
      { id: 'call_5', name: 'transpose_midi_clip', arguments: { clip_id: 'mid_p1' }, signature: null },
      { id: 'call_6', name: 'set_clip_gain', arguments: { clip_id: 'clp_1', gain_db: -2 }, signature: null },
      { id: 'call_7', name: 'remove_track', arguments: { track_id: 'trk_1' }, signature: null },
      { id: 'call_8', name: 'add_marker', arguments: { beat: 32, kind: 'chorus', label: 'Coro' }, signature: null },
      { id: 'call_9', name: 'set_instrument', arguments: { track_id: 'trk_3', preset: 'pad_calido' }, signature: null },
    ]
    let pend = prepareToolCalls(calls, registry, session)
    assert.deepEqual(pend.map((p) => p.status), ['pending', 'failed', 'failed', 'failed', 'failed', 'pending', 'failed', 'pending', 'failed'])
    assert.equal(pend[1].message, 'Herramienta desconocida.')
    assert.match(pend[2].message, /es de audio/)
    assert.match(pend[3].message, /No existe la pista "trk_9"/)
    assert.match(pend[4].message, /semitones/)
    assert.match(pend[6].message, /no tiene disponible/)
    assert.match(pend[8].message, /no es de caja de ritmos/)
    assert.equal(pend[0].description, 'Pista "Voz": fader a +12 dB')
    assert.throws(() => buildToolResults(calls, pend), /sin aplicar/)
    pend = await Promise.all(pend.map((p) => (p.callId === 'call_8' ? Promise.resolve(rejectPendingCommand(p)) : applyPendingCommand(p, registry, { session }))))
    assert.deepEqual(ran, [['track.set_mix', { track_id: 'trk_1', volume_db: 12 }]])
    assert.equal(pend[0].status, 'applied')
    assert.match(pend[0].message, /^Aplicado: .*Se acotaron al rango permitido: volume_db\./)
    assert.equal(pend[5].status, 'failed')
    assert.match(pend[5].message, /El clip quedó sin audio/)
    assert.equal(pend[7].status, 'rejected')
    const message = toolResultsMessage(calls, pend)
    assert.ok(message.role === 'tool')
    assert.deepEqual(message.toolResults.map((r) => [r.callId, r.name, r.response.status]), calls.map((c, i) => [c.id, c.name, pend[i].status]))
    assert.ok(message.toolResults.every((r) => r.response.message.length <= 500))
    const convo: StudioChatMessage[] = [{ role: 'user', text: 'Arregla la mezcla' }, { role: 'model', text: null, toolCalls: calls }, message]
    assert.equal(chatRequestProblem(chatRequest(convo, session)), null, 'el turno siguiente es valido')
  })

  console.log('chatMarkdown.ts: formato de las respuestas del asistente')

  await check('parseInline: negrita, cursiva, codigo y anidado', () => {
    assert.deepEqual(parseInline('Sube **el bajo** y *la voz* con `comp`'), [
      { kind: 'text', text: 'Sube ' },
      { kind: 'strong', children: [{ kind: 'text', text: 'el bajo' }] },
      { kind: 'text', text: ' y ' },
      { kind: 'em', children: [{ kind: 'text', text: 'la voz' }] },
      { kind: 'text', text: ' con ' },
      { kind: 'code', text: 'comp' },
    ])
    assert.deepEqual(parseInline('**fader *+3 dB***'), [
      { kind: 'strong', children: [{ kind: 'text', text: 'fader ' }, { kind: 'em', children: [{ kind: 'text', text: '+3 dB' }] }] },
    ])
    assert.deepEqual(parseInline('__Coro__'), [{ kind: 'strong', children: [{ kind: 'text', text: 'Coro' }] }])
  })

  await check('parseInline: lo que no cierra o va pegado a espacios queda como texto', () => {
    assert.deepEqual(parseInline('2 * 3 = 6'), [{ kind: 'text', text: '2 * 3 = 6' }])
    assert.deepEqual(parseInline('**sin cierre'), [{ kind: 'text', text: '**sin cierre' }])
    assert.deepEqual(parseInline('pista_de_voz'), [{ kind: 'text', text: 'pista_de_voz' }])
    assert.deepEqual(parseInline('<script>x</script>'), [{ kind: 'text', text: '<script>x</script>' }])
  })

  await check('parseChatMarkdown: parrafos, titulos, listas y bloque de codigo', () => {
    const blocks = parseChatMarkdown('## Propuesta\nPrimero:\nla mezcla\n\n- **Bajo**: -2 dB\n- Voz\n  sigue igual\n1. uno\n2) dos\n\n```\na  b\n```\nfin')
    assert.deepEqual(blocks.map((b) => b.kind), ['heading', 'paragraph', 'list', 'list', 'code', 'paragraph'])
    const para = blocks[1]
    assert.ok(para.kind === 'paragraph' && para.lines.length === 2)
    const bullets = blocks[2]
    assert.ok(bullets.kind === 'list' && !bullets.ordered && bullets.items.length === 2)
    assert.deepEqual(bullets.items[0][0], { kind: 'strong', children: [{ kind: 'text', text: 'Bajo' }] })
    assert.deepEqual(bullets.items[1], [{ kind: 'text', text: 'Voz sigue igual' }])
    const numbered = blocks[3]
    assert.ok(numbered.kind === 'list' && numbered.ordered && numbered.items.length === 2)
    assert.deepEqual(blocks[4], { kind: 'code', text: 'a  b' })
    assert.deepEqual(parseChatMarkdown(''), [])
  })

  // -------------------------------------------------------------------------
  // Ventana del asistente (assistantWindow.ts)
  // -------------------------------------------------------------------------

  const VP = { width: 1440, height: 900 }

  await check('ventana flotante: queda entera dentro del navegador, con tamano minimo y margen', () => {
    // Arrastrada fuera por la derecha y abajo: se pega al borde con margen.
    assert.deepEqual(clampFloatRect({ x: 2000, y: 1200, w: 420, h: 560 }, VP), { x: 1440 - ASSISTANT_EDGE_PX - 420, y: 900 - ASSISTANT_EDGE_PX - 560, w: 420, h: 560 })
    // Por la izquierda y arriba, igual.
    assert.deepEqual(clampFloatRect({ x: -300, y: -50, w: 420, h: 560 }, VP), { x: ASSISTANT_EDGE_PX, y: ASSISTANT_EDGE_PX, w: 420, h: 560 })
    // Achicada de mas: el minimo. Agrandada de mas: lo que cabe.
    const tiny = clampFloatRect({ x: 100, y: 100, w: 20, h: 10 }, VP)
    assert.deepEqual([tiny.w, tiny.h], [ASSISTANT_FLOAT_MIN_W, ASSISTANT_FLOAT_MIN_H])
    const huge = clampFloatRect({ x: 0, y: 0, w: 5000, h: 5000 }, VP)
    assert.deepEqual(huge, { x: ASSISTANT_EDGE_PX, y: ASSISTANT_EDGE_PX, w: 1440 - 2 * ASSISTANT_EDGE_PX, h: 900 - 2 * ASSISTANT_EDGE_PX })
    // Navegador mas chico que el minimo: ocupa lo que hay, sin salirse.
    const small = clampFloatRect({ x: 50, y: 50, w: 420, h: 560 }, { width: 280, height: 240 })
    assert.ok(small.x >= 0 && small.y >= 0 && small.x + small.w <= 280 && small.y + small.h <= 240, JSON.stringify(small))
    // NaN o basura no rompen: toma valores por defecto acotados.
    const junk = clampFloatRect({ x: Number.NaN, y: Number.POSITIVE_INFINITY, w: Number.NaN, h: -1 }, VP)
    assert.ok([junk.x, junk.y, junk.w, junk.h].every(Number.isFinite))
  })

  await check('columna acoplada: ancho entre el minimo y el 60 % del navegador', () => {
    assert.equal(clampDockWidth(100, VP), ASSISTANT_DOCK_MIN_W)
    assert.equal(clampDockWidth(9999, VP), ASSISTANT_DOCK_MAX_W)
    assert.equal(clampDockWidth(9999, { width: 800, height: 600 }), 480)
    assert.equal(clampDockWidth(410.6, VP), 411)
  })

  await check('layout del asistente: se guarda, se restaura saneado y Ctrl+J alterna con el ultimo modo', () => {
    const base = defaultAssistantLayout(VP)
    assert.equal(base.mode, 'minimized')
    const floating = withAssistantMode({ ...base, float: { x: 200, y: 100, w: 500, h: 600 } }, 'floating')
    assert.equal(floating.lastOpen, 'floating')
    const restored = parseAssistantLayout(serializeAssistantLayout(floating), VP)
    assert.deepEqual(restored, floating)
    // Ctrl+J: minimiza y vuelve al flotante, no al acoplado.
    const hidden = toggleAssistantLayout(floating)
    assert.deepEqual([hidden.mode, hidden.lastOpen], ['minimized', 'floating'])
    assert.equal(toggleAssistantLayout(hidden).mode, 'floating')
    // Restaurar en un navegador mas chico acota la ventana.
    const shrunk = parseAssistantLayout(serializeAssistantLayout({ ...floating, float: { x: 1300, y: 800, w: 500, h: 600 } }), { width: 800, height: 600 })
    assert.ok(shrunk.float.x + shrunk.float.w <= 800 - ASSISTANT_EDGE_PX && shrunk.float.y + shrunk.float.h <= 600 - ASSISTANT_EDGE_PX)
    // Basura: valores por defecto.
    assert.deepEqual(parseAssistantLayout('{no es json', VP), base)
    assert.deepEqual(parseAssistantLayout(null, VP), base)
    assert.equal(parseAssistantLayout(JSON.stringify({ mode: 'gigante', dockWidth: 'x' }), VP).mode, 'minimized')
  })

  const toolCall = (id: string, name: string, args: Record<string, unknown>): StudioChatToolCall => ({ id, name, arguments: args, signature: 'firma' })
  const storedChat = (): StoredAssistantChat => {
    const calls = [toolCall('call_1', 'add_marker', { beat: 16, kind: 'chorus', label: 'Coro' }), toolCall('call_2', 'set_track_mix', { track_id: 'trk_1', volume_db: -3 })]
    return {
      version: 1,
      messages: [
        { role: 'user', text: 'Marca el coro y baja la voz' },
        { role: 'model', text: 'Listo, **dos cambios**.', toolCalls: calls },
      ],
      proposal: {
        calls,
        pendings: [
          { callId: 'call_1', name: 'add_marker', commandId: 'marker.add', args: calls[0].arguments, description: 'Marca Coro en el compás 5', status: 'pending', message: '', adjusted: [], ignored: [], warnings: ['Nota fuera de la tonalidad'] },
          { callId: 'call_2', name: 'set_track_mix', commandId: 'track.set_mix', args: calls[1].arguments, description: 'Voz a -3 dB', status: 'rejected', message: 'El usuario rechazó el cambio.', adjusted: [], ignored: [] },
        ],
      },
      descriptions: { call_0: 'Antes' },
      approved: { kind: 'chat', estimatedCostUsd: 0.03, spentUsd: 0, budgetUsd: 20, allowed: true } as unknown as StoredAssistantChat['approved'],
      spentUsd: 0.06,
    }
  }

  await check('conversacion guardada: ida y vuelta por structured clone, con propuesta, avisos y costo confirmado', () => {
    const chat = storedChat()
    const back = parseStoredAssistantChat(structuredClone(serializeAssistantChat(chat)))
    assert.deepEqual(back, chat)
    assert.deepEqual(back?.proposal?.pendings[0].warnings, ['Nota fuera de la tonalidad'])
    assert.equal(back?.approved?.estimatedCostUsd, 0.03)
    // La conversacion restaurada sigue siendo valida para el Worker.
    assert.equal(chatRequestProblem(chatRequest([...(back?.messages ?? []), { role: 'tool', toolResults: [{ callId: 'call_1', name: 'add_marker', response: { status: 'applied', message: 'ok' } }, { callId: 'call_2', name: 'set_track_mix', response: { status: 'rejected', message: 'no' } }] }])), null)
  })

  await check('conversacion guardada: un cambio que se esta escuchando se guarda como aplicado', () => {
    const chat = storedChat()
    const decided = { ...chat.proposal!.pendings[0], status: 'applied' as const, message: 'Aplicado: Marca Coro.' }
    const saved = serializeAssistantChat(chat, decided)
    assert.equal(saved.proposal?.pendings[0].status, 'applied')
    assert.equal(chat.proposal?.pendings[0].status, 'pending', 'no muta la conversacion en memoria')
  })

  await check('conversacion guardada: lo danado se descarta y la propuesta huerfana no se restaura', () => {
    assert.equal(parseStoredAssistantChat(null), null)
    assert.equal(parseStoredAssistantChat({ version: 2, messages: [] }), null)
    assert.equal(parseStoredAssistantChat({ version: 1, messages: [{ role: 'system', text: 'x' }] }), null)
    assert.equal(parseStoredAssistantChat({ ...storedChat(), messages: [{ role: 'model', text: 'x', toolCalls: [{ id: 1 }] }] }), null)
    const orphan = parseStoredAssistantChat({ ...storedChat(), messages: [{ role: 'user', text: 'hola' }] })
    assert.equal(orphan?.proposal, null)
    const negative = parseStoredAssistantChat({ ...storedChat(), spentUsd: -4, approved: { kind: 'compose' } })
    assert.deepEqual([negative?.spentUsd, negative?.approved], [0, null])
    const long = { ...storedChat(), proposal: null, messages: Array.from({ length: ASSISTANT_CHAT_MAX_STORED + 10 }, (_, i) => ({ role: 'user' as const, text: `m${i}` })) }
    assert.equal(serializeAssistantChat(long).messages.length, ASSISTANT_CHAT_MAX_STORED)
  })

  await check('zona a escuchar: la del clip, la pista o la marca, en compases enteros de 1 a 16', () => {
    const s = fixtureSession() // 120 BPM, 4/4; clp_1 en 8 s (beat 16) de 20 s (40 beats); mid_p1 beats 16-32
    const z = (name: string, args: Record<string, unknown>, playhead = 0) => auditionZone({ name, args }, s, playhead)
    assert.deepEqual(z('set_clip_gain', { clip_id: 'clp_1', gain_db: -3 }), { startBeat: 16, endBeat: 56 })
    assert.deepEqual(z('transpose_midi_clip', { clip_id: 'mid_p1', semitones: 2 }), { startBeat: 16, endBeat: 32 })
    // Mover: la zona de donde sale y a donde llega.
    assert.deepEqual(z('move_clip', { clip_id: 'mid_p1', start_beat: 48 }), { startBeat: 16, endBeat: 64 })
    // Duplicar sin destino: el original y la copia justo despues.
    assert.deepEqual(z('duplicate_clip', { clip_id: 'mid_p1' }), { startBeat: 16, endBeat: 48 })
    // Clip nuevo fuera de compas: se ajusta a compases enteros.
    assert.deepEqual(z('add_midi_clip', { track_id: 'trk_2', start_beat: 2.5, length_beats: 3, notes: [] }), { startBeat: 0, endBeat: 8 })
    // Marca: 8 compases desde ella.
    assert.deepEqual(z('add_marker', { beat: 48, kind: 'chorus' }), { startBeat: 48, endBeat: 80 })
    assert.deepEqual(z('remove_marker', { marker_id: 'mk_2' }), { startBeat: 16, endBeat: 48 })
    // Pista: el clip que tiene el cabezal, desde el compas del cabezal.
    assert.deepEqual(z('set_track_mix', { track_id: 'trk_2', volume_db: -2 }, 21), { startBeat: 20, endBeat: 32 })
    assert.deepEqual(z('set_instrument', { track_id: 'trk_4', preset: 'basico' }, 0), { startBeat: 32, endBeat: 36 })
    // Sin zona deducible (master, tempo, clip inexistente): 8 compases desde el compas del cabezal.
    assert.deepEqual(z('set_master', { volume_db: -1 }, 18), { startBeat: 16, endBeat: 48 })
    assert.deepEqual(z('set_session_meta', { bpm: 100 }, 0), { startBeat: 0, endBeat: 32 })
    assert.deepEqual(z('delete_clip', { clip_id: 'clp_nada' }, 5), { startBeat: 4, endBeat: 36 })
    // Un clip larguisimo se escucha solo sus primeros 16 compases.
    const long = { ...s, tracks: s.tracks.map((t) => (t.id === 'trk_2' ? { ...t, midiClips: t.midiClips.map((c) => ({ ...c, lengthBeats: 400 })) } : t)) }
    assert.deepEqual(auditionZone({ name: 'quantize_midi_clip', args: { clip_id: 'mid_p1', grid: '1/16' } }, long, 0), { startBeat: 16, endBeat: 80 })
  })

  await check('chips de contexto y pedidos rapidos: pista, clip, loop y vista en espanol', () => {
    const s = fixtureSession()
    assert.equal(barRangeText({ startBeat: 16, endBeat: 32 }, 4), 'c. 5-8')
    assert.equal(barRangeText({ startBeat: 0, endBeat: 4 }, 4), 'c. 1')
    assert.equal(barRangeText({ startBeat: 2, endBeat: 3 }, 4), 'c. 1')
    const chips = assistantContextChips({ session: s, selectedTrackId: 'trk_2', selectedClipId: 'mid_p1', loop: { startBeat: 32, endBeat: 48 }, context: 'piano_roll' })
    assert.deepEqual(chips.map((c) => [c.id, c.label, c.value]), [
      ['track', 'PISTA', 'Pad'],
      ['clip', 'CLIP', 'c. 5-8'],
      ['loop', 'LOOP', 'c. 9-12'],
      ['view', 'VISTA', 'PIANO ROLL'],
    ])
    assert.deepEqual(assistantContextChips({ session: s, selectedTrackId: null, selectedClipId: 'clp_nada', loop: null, context: 'timeline' }).map((c) => c.id), ['view'])
    assert.match(quickActionText('mix', null, { startBeat: 32, endBeat: 48 }, 4), /^Revisa la mezcla en la zona del loop \(c\. 9-12\)/)
    assert.match(quickActionText('track', 'Pad', null, 4), /"Pad"/)
    assert.match(quickActionText('arrangement', null, null, 4), /^Sugiere un arreglo:/)
  })

  await check('resumen de sesion: el loop activo viaja como `loop` en beats; sin loop no se manda la clave', () => {
    const s = fixtureSession()
    const withLoop = buildSessionSummary(s, { ...VIEW, loop: { startBeat: 32, endBeat: 48 } })
    assert.deepEqual(withLoop.loop, { startBeat: 32, endBeat: 48 })
    assert.deepEqual((sessionSummaryToWire(withLoop) as { loop?: unknown }).loop, { start_beat: 32, end_beat: 48 })
    const without = sessionSummaryToWire(buildSessionSummary(s, VIEW))
    assert.ok(!('loop' in without), 'un Worker anterior rechaza claves desconocidas')
    assert.equal(buildSessionSummary(s, { ...VIEW, loop: { startBeat: 8, endBeat: 8 } }).loop, null)
    assert.equal(buildSessionSummary(s, { ...VIEW, loop: { startBeat: Number.NaN, endBeat: 8 } }).loop, null)
  })

  await check('comando view.toggle_assistant: Ctrl+J global, se registra en forma canonica', () => {
    const spec = STUDIO_COMMAND_SPECS.find((c) => c.id === 'view.toggle_assistant')
    assert.ok(spec)
    assert.deepEqual([spec.label, spec.category, spec.context, spec.defaultShortcuts, spec.assistantAllowed], ['Mostrar u ocultar el asistente', 'vista', 'global', ['Ctrl+J'], false])
    const reg = createCommandRegistry<null>()
    reg.register({ ...spec, run: () => {} })
    assert.ok(reg.get('view.toggle_assistant'))
  })

  console.log(`\n${passed} ok, ${failures.length} con falla`)
  if (failures.length > 0) process.exit(1)
}

void main()
