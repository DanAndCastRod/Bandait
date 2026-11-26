import React, { useEffect, useRef, useState } from 'react'
import { Cable, FlaskConical, Headphones, Mic, RefreshCw } from 'lucide-react'
import { recorderWarningMessage } from '../../services/studio/recorder'
import { STUDIO_LATENCY_OFFSET_MS_MAX, STUDIO_LATENCY_OFFSET_MS_MIN, STUDIO_MAX_ASSET_BYTES } from '../../services/studio/session'
import { maxTakeSeconds, useStudio, type StudioController, type StudioPanelProps } from './studioState'
import { useStudioCanvasPalette } from './useStudioCanvasPalette'

interface Props extends StudioPanelProps {
  /** false en navegadores sin grabacion o en pantallas angostas. */
  recordAllowed: boolean
  /** Motivo por el que no se puede grabar, para mostrarlo. */
  recordHint: string | null
  /** Abre la prueba de interfaz (StudioDeviceProbe); la vista suelta antes la entrada del Estudio. */
  onOpenProbe: () => void
}

const LEVEL_FLOOR_DB = -60

function levelFraction(db: number): number {
  if (!Number.isFinite(db)) return 0
  return Math.min(1, Math.max(0, (db - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB))
}

/** Cuanto dura como mucho una toma (WAV de 24 bits, tope de 200 MB por audio), en mono y en estereo. */
function maxTakeText(sampleRate: number): string {
  const minutes = (channels: number) => Math.floor(maxTakeSeconds({ channels, sampleRate, bitDepth: 24, maxBytes: STUDIO_MAX_ASSET_BYTES }) / 60)
  return sampleRate > 0 ? `${minutes(1)} min mono · ${minutes(2)} min estéreo` : 'no informa'
}

function yesNo(value: boolean | null): string {
  return value === null ? 'no informa' : value ? 'ACTIVO' : 'apagado'
}

/** Medidor horizontal de una entrada, pintado desde requestAnimationFrame. */
const InputLevel: React.FC<{ controller: StudioController; channel: 0 | 1 }> = ({ controller, channel }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const palette = useStudioCanvasPalette()

  // palette en las dependencias: un cambio de tema reinicia el bucle y repinta con los colores nuevos.
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    let hold = 0
    let last = -1
    return controller.onFrame(() => {
      const dpr = window.devicePixelRatio || 1
      const w = Math.round(canvas.clientWidth * dpr)
      const h = Math.round(canvas.clientHeight * dpr)
      if (w === 0 || h === 0) return
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        last = -1
      }
      const reading = controller.readInputLevel(channel)
      const peak = reading ? levelFraction(reading.peakDb) : 0
      const rms = reading ? levelFraction(reading.rmsDb) : 0
      hold = Math.max(peak, hold - 0.012)
      const signature = peak + rms * 2 + hold * 4
      if (Math.abs(signature - last) < 0.003) return
      last = signature
      const clipping = reading !== null && reading.peakDb >= -0.3
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = clipping ? palette.meterOver : palette.meterOkDim
      ctx.fillRect(0, 0, peak * w, h)
      ctx.fillStyle = clipping ? palette.meterOver : palette.meterOk
      ctx.fillRect(0, 0, rms * w, h)
      ctx.fillStyle = palette.meterHold
      if (hold > 0.01) ctx.fillRect(Math.min(w - dpr, hold * w), 0, Math.max(1, dpr), h)
      // Marca de -12 dBFS: nivel de trabajo razonable para grabar.
      ctx.fillStyle = palette.meterTick
      ctx.fillRect(levelFraction(-12) * w, 0, Math.max(1, dpr), h)
    })
  }, [controller, channel, palette])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '64px minmax(0, 1fr)', alignItems: 'center', gap: '8px' }}>
      <span className="stu-label">Entrada {channel + 1}</span>
      <canvas ref={canvasRef} aria-hidden="true" style={{ display: 'block', width: '100%', height: '8px', borderRadius: '2px', background: 'var(--stu-well)' }} />
    </div>
  )
}

/**
 * Panel de dispositivo: entrada de audio, lo que el navegador respeto de lo pedido, calibracion de
 * latencia, ajuste manual en milisegundos, monitoreo y acceso a la prueba de interfaz (fase 0).
 */
export const StudioDevicePanel: React.FC<Props> = ({ controller, recordAllowed, recordHint, onOpenProbe }) => {
  const snap = useStudio(controller)
  const { device, session, recording, ready } = snap
  const [pickedId, setPickedId] = useState('')
  const report = device.report
  const open = device.status !== 'closed' && report !== null
  // Orden: lo que se acaba de elegir, la entrada abierta, la recordada si sigue conectada y, si
  // no hay ninguna, la entrada por defecto del equipo (la primera de la lista).
  const preferredId = controller.preferredInputId()
  const rememberedId = device.inputs.some((input) => input.deviceId === preferredId) ? preferredId : ''
  const defaultId = device.inputs.find((input) => input.deviceId === 'default')?.deviceId ?? device.inputs[0]?.deviceId ?? ''
  const selectedId = pickedId || device.deviceId || rememberedId || defaultId
  const locked = recording || device.busy !== null || !ready

  if (!recordAllowed) {
    return (
      <div className="stu-section" data-testid="studio-device-panel">
        <span className="stu-badge" data-tone="warn" style={{ alignSelf: 'flex-start' }}>
          SOLO REPRODUCCIÓN Y MEZCLA
        </span>
        <p className="stu-help">{recordHint ?? 'La grabación no está disponible aquí.'}</p>
        <p className="stu-help">Puedes abrir sesiones, escuchar, editar clips, mezclar e importar audio. Para grabar, abre el Estudio en Chrome o Edge de escritorio, en una ventana de al menos 1024 px de ancho.</p>
      </div>
    )
  }

  const warnings = report ? report.warnings.filter((warning) => warning !== 'uncalibrated') : []
  const calibration = report?.calibration ?? null

  return (
    <div data-testid="studio-device-panel" style={{ display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }}>
      <section className="stu-section" aria-label="Entrada de audio">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          <span className="stu-label">
            <Mic size={11} style={{ verticalAlign: '-1px', marginRight: '4px' }} />
            Entrada
          </span>
          <span className="stu-badge" data-tone={recording ? 'rec' : open ? 'ok' : undefined} data-testid="studio-device-status">
            {recording ? 'GRABANDO' : device.busy === 'opening' ? 'ABRIENDO' : open ? 'ABIERTA' : 'CERRADA'}
          </span>
        </div>
        {device.inputs.length === 0 ? (
          <p className="stu-help">Sin elegir nada, el Estudio graba con el micrófono por defecto del equipo. Busca las entradas para usar otra, como una interfaz de audio. El navegador pedirá permiso de micrófono la primera vez.</p>
        ) : (
          <select className="stu-field" value={selectedId} disabled={locked} onChange={(event) => setPickedId(event.target.value)} aria-label="Entrada de audio" data-testid="studio-device-select">
            {device.inputs.map((input, index) => (
              <option key={input.deviceId || index} value={input.deviceId}>
                {input.label || `Entrada ${index + 1}`}
              </option>
            ))}
          </select>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          <button type="button" className="stu-btn" disabled={locked} onClick={() => void controller.refreshInputs()} data-testid="studio-device-list">
            <RefreshCw size={13} />
            {device.busy === 'listing' ? 'BUSCANDO...' : 'BUSCAR ENTRADAS'}
          </button>
          {device.inputs.length > 0 && (
            <button type="button" className="stu-btn" data-tone="primary" disabled={locked || !selectedId || (open && selectedId === device.deviceId)} onClick={() => void controller.openInput(selectedId)} data-testid="studio-device-open">
              {open && selectedId !== device.deviceId ? 'CAMBIAR' : 'ABRIR'}
            </button>
          )}
          {open && (
            <button type="button" className="stu-btn" disabled={locked} onClick={() => void controller.closeInput()} data-testid="studio-device-close">
              CERRAR
            </button>
          )}
        </div>
        {open && (
          <>
            <InputLevel controller={controller} channel={0} />
            {report.channelCount !== 1 && <InputLevel controller={controller} channel={1} />}
            <dl className="stu-kv">
              <dt>Canales</dt>
              <dd>{report.channelCount > 0 ? report.channelCount : 'no informa'}</dd>
              <dt>Frecuencia</dt>
              <dd>{report.sampleRate ? `${report.sampleRate} Hz` : 'no informa'}</dd>
              <dt>Cancelación de eco</dt>
              <dd>{yesNo(report.echoCancellation)}</dd>
              <dt>Supresión de ruido</dt>
              <dd>{yesNo(report.noiseSuppression)}</dd>
              <dt>Ganancia automática</dt>
              <dd>{yesNo(report.autoGainControl)}</dd>
              <dt title="Cada toma es un archivo WAV de 24 bits de hasta 200 MB. Al llegar al tope la toma se corta y el Estudio avisa al detener.">Toma máxima</dt>
              <dd data-testid="studio-device-max-take">{maxTakeText(session.sampleRate)}</dd>
            </dl>
            {warnings.length > 0 && (
              <ul className="stu-warnings" aria-label="Avisos de la entrada" data-testid="studio-device-warnings">
                {warnings.map((warning) => (
                  <li key={warning}>{recorderWarningMessage(warning)}</li>
                ))}
              </ul>
            )}
            <p className="stu-help">Arma una pista con su botón R y elige qué entrada graba en ella.</p>
          </>
        )}
      </section>

      <section className="stu-section" aria-label="Latencia">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          <span className="stu-label">
            <Cable size={11} style={{ verticalAlign: '-1px', marginRight: '4px' }} />
            Latencia
          </span>
          <span className="stu-badge" data-tone={calibration ? 'ok' : 'warn'} data-testid="studio-calibration-status">
            {calibration ? 'CALIBRADA' : 'SIN CALIBRAR'}
          </span>
        </div>
        {calibration ? (
          <dl className="stu-kv">
            <dt>Ida y vuelta</dt>
            <dd>{(calibration.roundTripSeconds * 1000).toFixed(2)} ms</dd>
            <dt>Variación</dt>
            <dd>{(calibration.spreadSeconds * 1000).toFixed(2)} ms</dd>
            <dt>Medida</dt>
            <dd>{new Date(calibration.measuredAt).toLocaleString()}</dd>
          </dl>
        ) : (
          <p className="stu-help">Sin calibrar, las tomas se alinean con la latencia que estima el navegador y pueden quedar corridas unos milisegundos.</p>
        )}
        <p className="stu-help">Para calibrar: conecta un cable de Salida 1 a Entrada 1 (o acerca el audífono al micrófono), baja el volumen de los monitores y pulsa CALIBRAR. Suena una ráfaga de clics tres veces.</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          <button type="button" className="stu-btn" disabled={!open || locked} onClick={() => void controller.calibrate()} data-testid="studio-calibrate">
            {device.busy === 'calibrating' ? 'MIDIENDO...' : 'CALIBRAR'}
          </button>
          {calibration && (
            <button type="button" className="stu-btn" data-tone="ghost" disabled={locked} onClick={() => controller.forgetCalibration()}>
              OLVIDAR
            </button>
          )}
        </div>
        <label className="stu-form-row">
          <span className="stu-label">Ajuste manual de esta sesión (ms)</span>
          <input
            key={`offset-${session.latencyOffsetMs}`}
            className="stu-field stu-mono"
            style={{ width: '96px' }}
            type="number"
            min={STUDIO_LATENCY_OFFSET_MS_MIN}
            max={STUDIO_LATENCY_OFFSET_MS_MAX}
            step={1}
            defaultValue={session.latencyOffsetMs}
            disabled={recording}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
            onBlur={(event) => {
              const value = Number(event.target.value)
              if (!Number.isFinite(value) || value === session.latencyOffsetMs) return
              controller.updateMeta({ latencyOffsetMs: Math.min(STUDIO_LATENCY_OFFSET_MS_MAX, Math.max(STUDIO_LATENCY_OFFSET_MS_MIN, value)) }, 'Ajuste de latencia')
            }}
            aria-label={`Ajuste manual de latencia en milisegundos, de ${STUDIO_LATENCY_OFFSET_MS_MIN} a ${STUDIO_LATENCY_OFFSET_MS_MAX}`}
            data-testid="studio-latency-offset"
          />
          <span className="stu-help">Positivo adelanta las tomas nuevas; negativo las atrasa. No mueve las ya grabadas.</span>
        </label>
      </section>

      <section className="stu-section" aria-label="Monitoreo">
        <span className="stu-label">
          <Headphones size={11} style={{ verticalAlign: '-1px', marginRight: '4px' }} />
          Monitoreo
        </span>
        <p className="stu-help">Escúchate con el monitoreo directo de la interfaz (perilla MIX en la UMC202HD): no tiene retardo.</p>
        <label className="stu-check">
          <input type="checkbox" checked={device.monitor} disabled={!open || recording} onChange={(event) => controller.setMonitor(event.target.checked)} data-testid="studio-monitor" />
          <span>Monitoreo por software. Llega con retardo y, con parlantes abiertos, puede acoplarse: úsalo solo si la interfaz no tiene monitoreo directo.</span>
        </label>
      </section>

      <section className="stu-section" aria-label="Prueba de interfaz">
        <span className="stu-label">
          <FlaskConical size={11} style={{ verticalAlign: '-1px', marginRight: '4px' }} />
          Prueba de interfaz
        </span>
        <p className="stu-help">Comprueba canales separados, bloques perdidos y variación de latencia antes de grabar en serio. Usa su propia entrada: la del Estudio se cierra mientras tanto.</p>
        <button type="button" className="stu-btn" style={{ alignSelf: 'flex-start' }} disabled={recording} onClick={onOpenProbe} data-testid="studio-open-probe">
          ABRIR PRUEBA
        </button>
      </section>
    </div>
  )
}
