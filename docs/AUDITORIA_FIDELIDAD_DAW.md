# Auditoría de fidelidad DAW del Estudio

Fecha: 2026-11-25. Agente: Claude Code (Opus 5.5), agente "Estudio" de la ola 1 del plan de Web 3.0,
en un worktree. Pedido de Daniel Castaneda por el agente principal.

Referencia: `docs/REQUERIMIENTOS_WEB_3.0.md`, sección 4 ("Criterios Obligatorios de Fidelidad DAW").
Se revisó punto por punto contra el código de `bandait-leader-web` (rutas relativas a
`bandait-leader-web/src/`; las líneas son las del commit de esta auditoría). Estado: **Existía**
(ya estaba antes del 2026-11-25), **Agregado** (en este bloque), **Falta** (queda pendiente, con el
motivo).

## 4.1 Cabecera y barra de transporte

| Criterio | Estado | Dónde |
|---|---|---|
| Reloj dual `COMPÁS.TIEMPO` + `MM:SS.m` | Existía | `components/studio/StudioTransport.tsx:91` y `:94`; se escribe por `controller.onFrame` (rAF), sin estado de React por cuadro (`:29`) |
| BPM editable | Existía | `StudioTransport.tsx:226` (campo, un paso de deshacer al soltar) |
| Tap Tempo visible | **Agregado** | Botón TAP en `StudioTransport.tsx:248`, al lado del BPM. Cuenta el golpe en `pointerdown` (como un pad) y con Enter/Espacio; usa el mismo `controller.tapTempo()` que Shift+T (`studioState.ts`, `timelineMath.tapTempo`) |
| Métrica / compás | Existía | `StudioTransport.tsx` campo "Compás" (tiempos por compás) |
| Metrónomo con conteo previo | Existía | Clic `StudioTransport.tsx:176`, volumen del clic, conteo `:200` (Shift+K) |
| Armado de grabación | Existía | R por pista (`StudioTrackHeader.tsx:233` MIDI, `:297` audio) y grabar en el transporte (`StudioTransport.tsx:142`) |
| Región de bucle sobre la regla | Existía (crear) / **Agregado** (arrastrar) | Crear arrastrando en la regla ya existía. Nuevo: tiradores en los bordes de la región (`StudioTimeline.tsx:543`) para estirarla o encogerla y arrastre del centro para moverla, con ajuste a la rejilla y Alt para soltarlo (`timelineMath.dragLoopRegion`). Un clic sin arrastrar sigue moviendo el cabezal |
| Deshacer / Rehacer | Existía | `StudioTimeline.tsx:1265` y Ctrl+Z / Ctrl+Y |
| Controles de Snap y Zoom visibles | Existía | Ajuste LIBRE/TIEMPO/COMPÁS `StudioTimeline.tsx:1338`; zoom -, AJUSTAR, + `:1363` |
| Paleta de comandos (`Ctrl+K`) y atajos | Existía | `services/studio/commands.ts:183`, `StudioCommandPalette.tsx`, hoja de atajos `StudioShortcuts.tsx` |

## 4.2 Línea de tiempo multipista

| Criterio | Estado | Dónde |
|---|---|---|
| Regla de compases con marcadores de sección | Existía | Banda de secciones de la canción `StudioTimeline.tsx:515` y marcas de la sesión `:558` (Shift+M) |
| Cabecera: color por rol | **Agregado** | `trackColor(index, role)` en `studioState.ts` (`ROLE_COLORS`): voz, coros, batería, bajo, guitarra, teclados, cuerdas, vientos, clic y guía tienen color fijo de la paleta existente; otro/instrumental/sin asignar siguen por posición. Lo usan cabecera, clips, canal del mezclador y piano roll |
| Cabecera: M, S | Existía | `StudioTrackHeader.tsx:330` y `:343` |
| Cabecera: R / armar | Existía | `StudioTrackHeader.tsx:233` y `:297` |
| Cabecera: selector de instrumento | **Agregado** (sonido) | Antes la cabecera mostraba tipo y preset como botón que llevaba al inspector. Ahora, en sintetizador y caja de ritmos, es un selector de preset (`StudioTrackHeader.tsx:249`) que cambia el sonido en un paso de deshacer (mismo camino que el inspector). Sampler y plugin web siguen con el botón al inspector |
| Cabecera: fader y paneo rápidos | Existía | `StudioTrackHeader.tsx:355` y `:377`, más el medidor `:397` |
| Formas de onda reales en clips de audio | Existía | `paintWave` en `StudioTimeline.tsx` (picos de `services/studio/peaks.ts`) |
| Tiradores de recorte y de fades | Existía | Bordes que recortan y manijas de fade (`StudioTimeline.tsx:267`, partes `start`/`end`/`fadeIn`/`fadeOut` del hit test) |
| Clips MIDI con previsualización de notas | Existía | `StudioTimeline.tsx:332` (notas en miniatura con la repetición desplegada) |
| Playhead vertical continuo por todos los carriles | Existía | `.stu-playhead` (`StudioTimeline.tsx:1515`, alto del contenido completo, movido con `transform` desde rAF) |
| Selección por rectángulo | **Agregado** | Arrastre en zona vacía (`StudioTimeline.tsx:951`, `kind: 'marquee'` `:680`, dibujo `:494`): elige los clips que toca, se ven elegidos mientras se arrastra; Shift o Ctrl suma a la selección y no mueve el cabezal. Lógica pura en `timelineMath.ts` (`marqueeFromPoints`, `clipsInMarquee`, `marqueeSelection`) |
| Silencio de clips MIDI | **Agregado** | Campo opcional `muted` (contrato `STUDIO_V2.md` 2.4). Tecla 0 silencia clips de audio y MIDI elegidos; el clip silenciado se dibuja atenuado, con borde punteado y la etiqueta SILENCIO |

## 4.3 Piano roll

| Criterio | Estado | Dónde |
|---|---|---|
| Teclado vertical de octavas | Existía | `paintRoll` en `StudioPianoRoll.tsx:151` (teclas blancas y negras, nombres de nota) |
| Cuadrícula de beats y subdivisiones | Existía | `StudioPianoRoll.tsx:179` (`gridStep` de la rejilla elegida) |
| Barra de herramientas (Seleccionar, Dibujar, Borrar, Cortar, Velocidad) | Existía | `StudioPianoRoll.tsx:58` (teclas 1..5) |
| Carril inferior de velocidades | Existía | `paintVelocity` `StudioPianoRoll.tsx:308`, editable arrastrando |
| Cuantización y transposición | Existía | `StudioPianoRoll.tsx:1032` (fuerza en %) y `:1056` |
| Selección por rectángulo de notas | Existía / **Agregado** (Ctrl) | `kind: 'rubber'` `StudioPianoRoll.tsx:374`. Antes sumaba solo con Shift; ahora también con Ctrl o Cmd, igual que en la línea de tiempo |

## 4.4 Consola de mezcla

| Criterio | Estado | Dónde |
|---|---|---|
| Canales verticales | Existía | `TrackStrip` en `StudioMixer.tsx` |
| Vúmetros LED peak/RMS por pista | Existía (barra continua) / **Agregado** (LED) | `paintMeter` `StudioMixer.tsx:74` ahora dibuja LEDs de 3 px con 1 px de separación: encendidos hasta el RMS, atenuados entre RMS y pico, retención de pico como un LED encendido; verde hasta -6 dB, ámbar hasta 0 dB, rojo encima (colores de la paleta del Estudio). Solo repinta si cambia la cantidad de LEDs; un solo rAF para todo el mezclador. Lógica en `services/studio/faderScale.ts` (`ledSegmentCount`, `ledZone`, `ledLitCount`) |
| Slots de inserción (EQ, COMP) | Existía | `InsertSlot` `StudioMixer.tsx:149` (EQ con curva, COMP; en el master también LIM) |
| Envío a reverb | Existía | `StudioMixer.tsx:315` |
| Fader vertical con escala dB real de +12 a -60 | Existía / **Agregado** (marca -60) | `FaderColumn` `StudioMixer.tsx:196`. La escala impresa llegaba a -40; ahora llega a -60 (`FADER_MARKS`). La curva se movió a `services/studio/faderScale.ts` (pura, con pruebas) sin cambiar sus valores: 0 dB a tres cuartos |
| Master con LUFS integrada/momentánea y True Peak | Existía | `StudioMixer.tsx:449` y `:455`, lecturas desde rAF y botón REINICIAR |

## 4.5 Densidad técnica coherente

| Criterio | Estado | Dónde |
|---|---|---|
| Redondez configurable 8 px a 999 px, temas Dark Grafito / Light Estudio, acento WCAG | Falta (otro agente) | Lo hace en paralelo el agente de temas y redondez. Aquí no se tocaron tokens globales ni radios; lo nuevo usa `.stu-btn`, `.stu-field` y los tokens `--stu-*` existentes. En `studio.css` siguen radios de 2 a 6 px heredados (p. ej. `.stu-head-inst`, `.stu-tl`): los resuelve ese agente con la redondez configurable |
| Densidad compacta de consola | Existía | Cabeceras de 248 px, filas de 112 px, fuentes mono de 9 a 11 px. Lo agregado no agranda nada: el selector de preset reemplaza al botón en el mismo lugar y el TAP es un botón pequeño |

## Colores en canvas

Los dibujos en canvas (línea de tiempo, medidores) usan literales hexadecimales porque el canvas no
lee variables CSS; lo nuevo reutiliza solo valores que ya estaban en la paleta del Estudio
(`#5CC8C2` = `--stu-play`, `#D9A24E` = `--stu-warn`, `#D96459` = `--stu-rec`, `#7AA5D6` = `--stu-sel`,
`#1D2127` de la rejilla). Cuando el agente de temas haga el tema claro, el canvas va a necesitar
leer los tokens (pendiente abajo).

## Pendientes

1. Canvas y temas: la línea de tiempo, el piano roll y los medidores pintan con colores fijos del
   tema oscuro. Para Light Estudio hay que leer los `--stu-*` con `getComputedStyle` al cambiar de
   tema y pasarlos a las funciones de pintado.
2. **Resuelto (2026-11-26, ola 2 de Web 3.0).** El resumen de sesión del chat marca el clip MIDI
   silenciado con `"muted": true` (solo en true; `chatContext.midiClipMutedFlag`, `jobs.ts`,
   `studioCloud.sessionSummaryToWire`, contrato `STUDIO_V2.md` 4.3.2). `validateSummary` del Worker
   ya aceptaba claves extra en cada clip, así que no cambió; su prompt dice qué significa.
3. Selector de instrumento en la cabecera para sampler y plugins web (hoy llevan al inspector).
4. **Resuelto (2026-11-26).** El rectángulo de selección desplaza la vista sola cerca de los bordes
   del carril (horizontal y vertical), aunque el puntero no se mueva (`timelineMath.edgeScrollSpeed`,
   bucle de `StudioTimeline`).
5. **Resuelto (2026-11-26).** Las cabeceras de pista usan los mismos medidores LED de pico y RMS que
   la consola (`components/studio/ledMeter.ts`, escala del fader).
