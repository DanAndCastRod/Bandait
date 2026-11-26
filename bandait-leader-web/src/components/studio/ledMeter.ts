/**
 * Medidores LED de pico y RMS del Estudio (consola de mezcla y cabeceras de pista). Se pintan en
 * un <canvas> desde el requestAnimationFrame del controlador, sin estado de React, y solo cuando
 * cambia la cantidad de LEDs encendidos. La escala es la del fader (services/studio/faderScale):
 * verde hasta -6 dB, ambar hasta 0 dB y rojo encima, con los colores del tema vigente.
 */
import { dbToFader, LED_GAP_PX, ledLitCount, ledSegmentCount, ledZone, type LedZone } from '../../services/studio/faderScale'
import type { StudioCanvasPalette } from '../../services/studioCanvasPalette'

export interface MeterState {
  hold: number
  holdUntil: number
  lastPeak: number
  lastRms: number
  lastHold: number
}

export function newMeterState(): MeterState {
  return { hold: 0, holdUntil: 0, lastPeak: -1, lastRms: -1, lastHold: -1 }
}

export interface LedColors {
  zones: Readonly<Record<LedZone, { on: string; dim: string }>>
  off: string
}

const ledColorsCache = new WeakMap<StudioCanvasPalette, LedColors>()

/**
 * Colores de los LED por zona, del tema vigente (verde, ambar, rojo): encendido por el RMS,
 * atenuado entre el RMS y el pico, apagado arriba. Uno por paleta.
 */
export function ledColors(pal: StudioCanvasPalette): LedColors {
  let leds = ledColorsCache.get(pal)
  if (!leds) {
    leds = {
      zones: {
        ok: { on: pal.meterOk, dim: pal.meterOkLedDim },
        hot: { on: pal.meterHot, dim: pal.meterHotDim },
        over: { on: pal.meterOver, dim: pal.meterOverDim },
      },
      off: pal.meterOff,
    }
    ledColorsCache.set(pal, leds)
  }
  return leds
}

/** Zona de cada LED por cantidad de LEDs: se calcula una vez por alto de medidor. */
const ledZonesCache = new Map<number, LedZone[]>()

function ledZones(count: number): LedZone[] {
  let zones = ledZonesCache.get(count)
  if (!zones) {
    zones = Array.from({ length: count }, (_, i) => ledZone(i, count))
    ledZonesCache.set(count, zones)
  }
  return zones
}

/**
 * Pinta un medidor LED vertical: encendidos hasta el RMS, atenuados entre el RMS y el pico, y la
 * retencion de pico como un LED encendido que cae despues de 900 ms. No repinta si nada cambio.
 */
export function paintLedMeter(canvas: HTMLCanvasElement, state: MeterState, peakDb: number, rmsDb: number, now: number, leds: LedColors): void {
  const dpr = window.devicePixelRatio || 1
  const w = Math.round(canvas.clientWidth * dpr)
  const h = Math.round(canvas.clientHeight * dpr)
  if (w === 0 || h === 0) return
  let resized = false
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
    resized = true
  }
  const count = ledSegmentCount(canvas.clientHeight)
  if (count === 0) return
  const peak = ledLitCount(dbToFader(peakDb), count)
  const rms = ledLitCount(dbToFader(rmsDb), count)
  if (peak >= state.hold) {
    state.hold = peak
    state.holdUntil = now + 900
  } else if (now > state.holdUntil) {
    state.hold = Math.max(peak, state.hold - 0.5)
  }
  const hold = Math.round(state.hold)
  // Sin cambios no se repinta: una pista en silencio no gasta nada.
  if (!resized && peak === state.lastPeak && rms === state.lastRms && hold === state.lastHold) return
  state.lastPeak = peak
  state.lastRms = rms
  state.lastHold = hold
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const zones = ledZones(count)
  const pitch = h / count
  const gap = Math.max(1, Math.round(LED_GAP_PX * dpr))
  ctx.clearRect(0, 0, w, h)
  for (let i = 0; i < count; i++) {
    const colors = leds.zones[zones[i]]
    ctx.fillStyle = i < rms ? colors.on : i < peak ? colors.dim : i === hold - 1 ? colors.on : leds.off
    const y0 = Math.round(h - (i + 1) * pitch)
    const y1 = Math.round(h - i * pitch) - gap
    ctx.fillRect(0, y0, w, Math.max(1, y1 - y0))
  }
}
