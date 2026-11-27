# Estudio v2: pistas de instrumento, clips MIDI, marcas y trabajos `compose`, `analyze` y `chat`

Fecha: 2026-11-19. Estado: normativo para el Estudio Bandait v2 (`docs/PLAN_ESTUDIO_V2.md`).
Ejemplo canónico en `fixtures/studio_session_v2.json`; herramientas del asistente en
`fixtures/studio_chat_tools_v2.json`. Las pruebas del Hub y del Worker validan contra esos
archivos.

Este documento **no reemplaza** a `STUDIO_V1.md`: dice solo lo que cambia. Todo lo que aquí no
se menciona (reglas generales, audios, clips de audio, master, efectos, alineación de tomas,
rutas del Worker, audios en R2, trabajos `master`, `separate`, `generate` y `assist`, control de
gasto, variables) sigue exactamente como en v1, y se cita con la sección de v1 entre paréntesis.

Si el código y este contrato no coinciden, se corrigen primero el contrato y los fixtures.

## 1. Versiones y migración

- `version` es `2`. El Hub y el Worker **leen** `1` y `2`; cualquier otro valor se rechaza con
  `unsupported_version`.
- El Hub **escribe siempre** `2` (`serializeSession`). Un documento v1 se valida con las reglas
  de v1 (campo desconocido = error, como en v1) y se migra al abrirlo; se guarda como v2 en el
  siguiente guardado, local o en la nube.
- Migración v1 a v2, completa y sin pérdida:
  1. `version` pasa a `2`.
  2. Cada pista recibe `"kind": "audio"`, inmediatamente después de `id`. El resto de la pista
     (incluidos sus `clips`) queda igual.
  3. La raíz recibe `"markers": []`, después de `tracks`.
  4. Nada más cambia: audios, clips, efectos y master son los mismos.
- La migración es pura y determinista: migrar dos veces el mismo v1 da el mismo v2, y
  `parse(serialize(parse(v1)))` es igual a `parse(v1)`.
- El Worker guarda el documento tal como llega (v1 o v2); no migra. El Hub migra al leer.

## 2. Documento de sesión v2

### 2.1 Raíz

Igual que v1 (v1 2.1), con estos cambios:

```
version             2
tracks              Track[], 0..16, en orden de pantalla. Pistas de audio y de instrumento
                    cuentan juntas para el tope de 16
markers             Marker[], 0..256 (sección 2.6). Opcional al leer: ausente = []. El Hub
                    siempre lo escribe
chords              Chord[], 0..2048 (sección 2.9). Opcional al leer: ausente = []. El Hub lo
                    escribe SOLO si no está vacío (desde 2026-11-22)
```

Orden de las claves al serializar: `version`, `id`, `title`, `song_id`, `bpm`,
`beats_per_bar`, `key`, `sample_rate`, `latency_offset_ms`, `updated_at`, `updated_by`,
`assets`, `tracks`, `markers`, `chords` (si va), `master`.

Compatibilidad de `chords`: un documento sin acordes es idéntico al de antes, así que un Worker
anterior lo sigue aceptando. Un documento **con** `chords` exige un Worker que conozca el campo
(un Worker anterior responde 400 `bad_session` / `unknown_field`): se despliega el Worker antes
que el Hub que lo escribe.

**Tiempo en beats.** Los clips MIDI, las notas y las marcas se miden en **beats** (negras), no en
segundos, para que sobrevivan a un cambio de tempo. El beat `0` es el segundo `0.0` (inicio del
compás 1). Con un único tempo por sesión (como v1; mapa de tempo fuera de alcance):

```
segundos = beats * 60 / bpm
```

Todo valor en beats es un número finito. Los editores lo redondean a 6 decimales
(`roundBeat`); el validador no lo exige.

### 2.2 Track (pista)

Campos comunes, iguales que en v1 (v1 2.3): `id`, `name`, `role`, `volume_db`, `pan`, `mute`,
`solo`, `reverb_send_db`, `fx`. Nuevo y obligatorio:

```
kind             "audio" | "instrument"
```

Según `kind`:

| `kind` | Campos propios | Campos prohibidos (`unknown_field`) |
|---|---|---|
| `audio` | `clips`: Clip[] 0..256, igual que v1 (v1 2.4) | `instrument`, `midi_clips`, `frozen_asset_id` |
| `instrument` | `instrument` (2.3), `midi_clips`: MidiClip[] 0..256 (2.4), `frozen_asset_id` | `clips` |

```
frozen_asset_id  string | null. Obligatorio en una pista de instrumento. Audio de `assets`
                 con el render del instrumento ("congelado"), o null
```

Orden de las claves: `id`, `kind`, `name`, `role`, `volume_db`, `pan`, `mute`, `solo`,
`reverb_send_db`, `fx` y luego `clips` (audio) o `instrument`, `midi_clips`, `frozen_asset_id`
(instrumento).

Reglas:

- `role` es un rol de `stem_names.json` o `unknown`, como en v1. Para una pista de instrumento
  nueva el Hub propone `drums` (caja de ritmos), `keys` (sintetizador) u `other` (sampler).
- La pista de instrumento pasa por la misma cadena que una de audio (v1 2.3 y la cadena del
  grafo): la salida del instrumento entra donde entrarían los clips de audio, antes de los
  `fx`. Mute, solo, envío y fader funcionan igual.
- **Congelado.** `frozen_asset_id` apunta a un audio de `assets` (si no, `unknown_asset`). Suena
  desde el segundo `0.0` de la sesión, con su duración completa, en lugar del instrumento,
  **solo cuando el instrumento no está disponible** en ese equipo (un plugin WAM que no está en la
  lista cerrada de ese Hub, sección 2.3.4). Si el instrumento está disponible, el congelado no
  suena. El congelado no cuenta como clip, ni para el tope de clips ni para el fin de la sesión.
- Una pista de instrumento sin instrumento disponible y sin congelado no suena; la interfaz lo
  avisa. No es un error del documento.

### 2.3 Instrument

Objeto obligatorio en toda pista de instrumento. `type` decide la forma:

| `type` | Claves, en este orden |
|---|---|
| `synth` | `type`, `preset`, `params` |
| `drums` | `type`, `preset`, `params` |
| `sampler` | `type`, `params`, `zones` |
| `wam` | `type`, `plugin_id`, `state` |

Una clave que no corresponde a su `type` es `unknown_field`. `type` fuera de la lista:
`bad_value`.

**Parámetros (`params`).** Igual que los efectos (v1 2.6): un parámetro ausente toma su valor
por defecto (el de la tabla, **no** el del preset); `serializeSession` siempre los escribe todos,
en el orden de la tabla; uno desconocido es `unknown_field`, uno fuera de rango `out_of_range`,
uno de tipo incorrecto `bad_type`. Hay dos clases de parámetro:

- numérico: número finito en el rango; los marcados "entero" deben ser enteros (`bad_type`);
- de lista: texto de la lista permitida (`bad_value` si no está).

**`preset`.** `string | null`. Id de un preset de su tipo (tablas siguientes) o `null`
(personalizado). Un id que no está en la tabla es `bad_value`. Es solo el origen: el sonido lo
definen `params`. Elegir un preset en la interfaz escribe todos sus parámetros; tocar un
parámetro después **no** cambia `preset` (la interfaz muestra "modificado" si difieren).

**Determinismo.** Todos los instrumentos propios son deterministas: el mismo documento suena
igual en tiempo real y en `OfflineAudioContext`. Todo ruido sale de un generador pseudoaleatorio
con semilla fija por voz. Los LFO arrancan con fase 0 en cada nota.

**Polifonía.** 32 voces por pista. Con las 32 ocupadas, una nota nueva roba una voz, en este
orden: la voz en relajación (después de su note-off) más antigua; si no hay, la voz más antigua;
a igual antigüedad, la de menor velocidad. La voz robada se apaga con una rampa de 5 ms.

#### 2.3.1 `synth`: sintetizador sustractivo

Por voz: oscilador 1 + oscilador 2 + ruido -> filtro con envolvente -> amplificador con ADSR ->
suma de voces -> `gain_db` -> entrada de la pista.

- Frecuencia de un oscilador: `440 * 2^((pitch - 69) / 12) * 2^octave * 2^(detune_cents / 1200)`.
- Corte del filtro: `filter_cutoff_hz * 2^(env * filter_env_octaves + lfo_filtro)`, acotado a
  20..20000 Hz; `env` es la envolvente del filtro, de 0 a 1.
- Ganancia por velocidad: `1 - velocity_sens * (1 - velocity / 127)`.
- LFO por voz, fase 0 al empezar la nota. Con `lfo_depth` 1: `pitch` = +/-100 cents,
  `filter` = +/-2 octavas, `amp` = trémolo de 100 % (la ganancia oscila entre 0 y 1).
- Una nota dura `length`; al terminar empieza la relajación de las dos envolventes.

| Parámetro | Clase | Rango o lista | Por defecto |
|---|---|---|---|
| `osc1_wave` | lista | `sine`, `triangle`, `sawtooth`, `square` | `sawtooth` |
| `osc1_octave` | entero | -2..2 | 0 |
| `osc1_detune_cents` | número | -100..100 | 0 |
| `osc1_level` | número | 0..1 | 0.8 |
| `osc2_wave` | lista | `sine`, `triangle`, `sawtooth`, `square` | `square` |
| `osc2_octave` | entero | -2..2 | 0 |
| `osc2_detune_cents` | número | -100..100 | 7 |
| `osc2_level` | número | 0..1 | 0.4 |
| `noise_level` | número | 0..1 | 0 |
| `filter_type` | lista | `lowpass`, `highpass`, `bandpass` | `lowpass` |
| `filter_cutoff_hz` | número | 20..20000 | 2400 |
| `filter_resonance` | número | 0.1..20 (Q) | 1 |
| `filter_env_octaves` | número | -8..8 | 2 |
| `filter_attack_ms` | número | 0..10000 | 5 |
| `filter_decay_ms` | número | 0..10000 | 400 |
| `filter_sustain` | número | 0..1 | 0.3 |
| `filter_release_ms` | número | 0..10000 | 300 |
| `amp_attack_ms` | número | 0..10000 | 5 |
| `amp_decay_ms` | número | 0..10000 | 200 |
| `amp_sustain` | número | 0..1 | 0.7 |
| `amp_release_ms` | número | 0..10000 | 250 |
| `lfo_wave` | lista | `sine`, `triangle`, `sawtooth`, `square` | `sine` |
| `lfo_rate_hz` | número | 0.01..20 | 5 |
| `lfo_target` | lista | `off`, `pitch`, `filter`, `amp` | `off` |
| `lfo_depth` | número | 0..1 | 0 |
| `velocity_sens` | número | 0..1 | 0.7 |
| `gain_db` | número | -24..12 | -6 |

Presets del `synth` (lo que no se lista toma el valor por defecto de la tabla anterior). El
sintetizador nuevo empieza con `teclas_suaves`.

| `preset` | Nombre | Parámetros que cambian |
|---|---|---|
| `pad_calido` | Pad cálido | `osc2_wave` sawtooth, `osc2_detune_cents` 9, `osc2_level` 0.6, `filter_cutoff_hz` 1200, `filter_resonance` 0.8, `filter_env_octaves` 1, `filter_attack_ms` 800, `filter_decay_ms` 1500, `filter_sustain` 0.5, `filter_release_ms` 1500, `amp_attack_ms` 600, `amp_decay_ms` 1000, `amp_sustain` 0.8, `amp_release_ms` 1800, `lfo_rate_hz` 0.3, `lfo_target` filter, `lfo_depth` 0.2, `velocity_sens` 0.3, `gain_db` -10 |
| `bajo_sub` | Bajo sub | `osc1_wave` sine, `osc1_octave` -1, `osc2_wave` triangle, `osc2_octave` -1, `osc2_detune_cents` 0, `osc2_level` 0.3, `filter_cutoff_hz` 400, `filter_env_octaves` 0.5, `amp_attack_ms` 3, `amp_decay_ms` 300, `amp_sustain` 0.9, `amp_release_ms` 120, `velocity_sens` 0.5, `gain_db` -4 |
| `bajo_sintetico` | Bajo sintético | `osc1_octave` -1, `osc2_octave` -1, `osc2_detune_cents` 5, `osc2_level` 0.5, `filter_cutoff_hz` 500, `filter_resonance` 4, `filter_env_octaves` 3, `filter_decay_ms` 250, `filter_sustain` 0.2, `amp_attack_ms` 2, `amp_decay_ms` 300, `amp_sustain` 0.8, `amp_release_ms` 100 |
| `lead_brillante` | Lead brillante | `osc2_wave` sawtooth, `osc2_detune_cents` 14, `osc2_level` 0.6, `filter_cutoff_hz` 3500, `filter_resonance` 2, `filter_env_octaves` 1.5, `amp_attack_ms` 8, `amp_sustain` 0.85, `amp_release_ms` 200, `lfo_rate_hz` 5.5, `lfo_target` pitch, `lfo_depth` 0.15, `gain_db` -8 |
| `pluck` | Pluck | `osc2_wave` triangle, `osc2_octave` 1, `osc2_detune_cents` 0, `osc2_level` 0.3, `filter_cutoff_hz` 600, `filter_resonance` 1.5, `filter_env_octaves` 4, `filter_attack_ms` 0, `filter_decay_ms` 180, `filter_sustain` 0, `filter_release_ms` 180, `amp_attack_ms` 1, `amp_decay_ms` 350, `amp_sustain` 0 |
| `cuerdas` | Cuerdas | `osc2_wave` sawtooth, `osc2_detune_cents` -8, `osc2_level` 0.7, `filter_cutoff_hz` 2800, `filter_resonance` 0.7, `filter_env_octaves` 0.5, `amp_attack_ms` 350, `amp_decay_ms` 500, `amp_sustain` 0.85, `amp_release_ms` 900, `lfo_rate_hz` 4.5, `lfo_target` pitch, `lfo_depth` 0.06, `velocity_sens` 0.5, `gain_db` -10 |
| `organo` | Órgano | `osc1_wave` sine, `osc2_wave` sine, `osc2_octave` 1, `osc2_detune_cents` 0, `osc2_level` 0.6, `filter_cutoff_hz` 8000, `filter_env_octaves` 0, `amp_attack_ms` 4, `amp_decay_ms` 10, `amp_sustain` 1, `amp_release_ms` 60, `lfo_rate_hz` 6, `lfo_target` amp, `lfo_depth` 0.1, `velocity_sens` 0, `gain_db` -8 |
| `campanas` | Campanas | `osc1_wave` sine, `osc2_wave` triangle, `osc2_octave` 2, `osc2_detune_cents` 3, `osc2_level` 0.35, `filter_cutoff_hz` 6000, `filter_env_octaves` 0, `amp_attack_ms` 1, `amp_decay_ms` 1800, `amp_sustain` 0, `amp_release_ms` 1500, `gain_db` -8 |
| `teclas_suaves` | Teclas suaves | `osc1_wave` triangle, `osc2_wave` sine, `osc2_octave` 1, `osc2_detune_cents` 0, `osc2_level` 0.25, `filter_cutoff_hz` 1800, `filter_env_octaves` 1.5, `filter_decay_ms` 600, `filter_sustain` 0.2, `amp_attack_ms` 3, `amp_decay_ms` 1200, `amp_sustain` 0.3, `amp_release_ms` 400, `velocity_sens` 0.8 |

#### 2.3.2 `drums`: caja de ritmos sintetizada

Nueve voces sintetizadas, de disparo único: la duración de la nota no corta el sonido, que dura
lo que su envolvente. Un golpe de `hat_closed` corta el `hat_open` que esté sonando (rampa de
5 ms). La ganancia es `velocity / 127`. Cada golpe de la misma voz reinicia esa voz (no se suman
dos golpes de la misma voz en el mismo instante).

Voces y mapa de General MIDI (canal de percusión). La nota canónica es la que escriben el piano
roll, `compose` y la exportación `.mid`. Las demás notas de la lista también disparan la voz;
cualquier otra nota no suena (no es un error del documento).

| Voz | Nombre | Nota canónica | Notas GM que la disparan | Sonido de referencia |
|---|---|---|---|---|
| `kick` | Bombo | 36 | 35, 36 | seno de 150 a 50 Hz en 50 ms, caída 400 ms |
| `snare` | Caja | 38 | 37, 38, 40 | ruido pasa banda 1800 Hz + triángulo 185 Hz, caída 180 ms |
| `clap` | Palmas | 39 | 39 | ruido pasa banda 1200 Hz en tres ráfagas separadas 10 ms, caída 200 ms |
| `hat_closed` | Hi-hat cerrado | 42 | 42, 44 | ruido pasa altos 7000 Hz, caída 50 ms |
| `hat_open` | Hi-hat abierto | 46 | 46 | ruido pasa altos 7000 Hz, caída 350 ms |
| `tom_low` | Tom grave | 41 | 41, 43 | seno de 140 a 100 Hz, caída 350 ms |
| `tom_mid` | Tom medio | 45 | 45, 47 | seno de 210 a 150 Hz, caída 300 ms |
| `tom_high` | Tom agudo | 48 | 48, 50 | seno de 300 a 220 Hz, caída 250 ms |
| `cymbal` | Platillo | 49 | 49, 51, 52, 53, 55, 57, 59 | ruido pasa altos 5000 Hz, caída 1500 ms |

El "sonido de referencia" orienta la implementación; no es normativo al hertz. Lo normativo son
las voces, el mapa de notas, los parámetros y el determinismo.

Parámetros: tres por voz, con el nombre de la voz como prefijo (`kick_level_db`,
`kick_tune`, `kick_decay`, ... `cymbal_decay`), en el orden de la tabla de voces, y al final
`gain_db`. En total 28.

| Parámetro | Clase | Rango | Por defecto | Qué es |
|---|---|---|---|---|
| `<voz>_level_db` | número | -60..6 | 0 | Nivel de la voz; -60 es silencio |
| `<voz>_tune` | número | -12..12 | 0 | Afinación en semitonos (frecuencias y filtros de la voz) |
| `<voz>_decay` | número | 0.25..4 | 1 | Multiplicador de la caída de referencia |
| `gain_db` | número | -24..12 | -6 | Salida del instrumento |

Presets de `drums` (lo que no se lista queda por defecto). La caja nueva empieza con `basico`.

| `preset` | Nombre | Parámetros que cambian |
|---|---|---|
| `basico` | Básico | ninguno |
| `seco` | Seco | todas las `<voz>_decay` 0.6, salvo `cymbal_decay` 0.5 |
| `amplio` | Amplio | todas las `<voz>_decay` 1.5; `kick_tune` -2; `snare_level_db` -2 |
| `lofi` | Lo-fi | todas las `<voz>_tune` -3; todas las `<voz>_decay` 0.8; `hat_closed_level_db` -6; `hat_open_level_db` -6; `cymbal_level_db` -6 |

#### 2.3.3 `sampler`: muestras de la sesión

```
params   parámetros (tabla siguiente)
zones    Zone[], 0..64
```

Zone (claves en este orden):

```
asset_id        string, audio de `assets` (si no, unknown_asset)
root_pitch      entero 0..127. Nota en la que el audio suena sin transponer
low_pitch       entero 0..127
high_pitch      entero 0..127, >= low_pitch (si no, bad_zone)
low_velocity    entero 1..127
high_velocity   entero 1..127, >= low_velocity (si no, bad_zone)
offset_s        número >= 0. Inicio de la ventana dentro del audio
length_s        número >= 0.01. Largo de la ventana
gain_db         número -60..24
tune_cents      número -100..100
```

- `offset_s + length_s <= duration_s` del audio, tolerancia 0.001 s (si no, `clip_out_of_asset`).
- Una nota suena en **todas** las zonas cuyo rango de nota y de velocidad la contienen (capas).
  Ninguna zona: silencio.
- Velocidad de lectura: `2^((pitch - root_pitch) / 12 + tune_cents / 1200)`. La ventana se lee
  desde `offset_s`; el sonido termina al acabar la ventana aunque la nota siga.
- Con `mode` `sustain` la nota-off inicia la relajación; con `one_shot` se ignora la nota-off y
  suena la ventana completa (con su relajación al final de la ventana).
- Un audio de zona que falta en el equipo hace muda esa zona; no es error del documento.

| Parámetro | Clase | Rango o lista | Por defecto |
|---|---|---|---|
| `amp_attack_ms` | número | 0..10000 | 2 |
| `amp_decay_ms` | número | 0..10000 | 0 |
| `amp_sustain` | número | 0..1 | 1 |
| `amp_release_ms` | número | 0..10000 | 150 |
| `velocity_sens` | número | 0..1 | 0.7 |
| `mode` | lista | `sustain`, `one_shot` | `sustain` |
| `gain_db` | número | -24..12 | 0 |

#### 2.3.4 `wam`: plugin web (WAM 2.0) de la lista cerrada

```
plugin_id   string, ^[a-z0-9][a-z0-9_.-]{0,79}$ (si no, bad_value)
state       objeto JSON opaco del plugin. Serializado ocupa hasta 16384 bytes UTF-8 (si no,
            out_of_range). Su contenido no se valida
```

- Solo se cargan plugins de la **lista cerrada** que trae cada versión del Hub, empaquetados con
  él. Nunca se carga código desde una URL del documento ni de ningún otro lado: sería ejecutar
  código ajeno en la sesión del usuario. El documento no lleva URL.
- Un `plugin_id` que no está en la lista de ese Hub **no** es error del documento: el instrumento
  queda "no disponible" y suena el congelado si lo hay (2.2). Así un documento hecho con un Hub
  más nuevo se abre en uno más viejo.
- En esta etapa la lista cerrada está **vacía** (`STUDIO_WAM_PLUGINS` en el Hub): el anfitrión
  existe, pero ningún plugin está aprobado todavía. Agregar uno exige verificar su licencia y
  empaquetarlo; no cambia este contrato.

### 2.4 MidiClip

```
id            string. Los ids de clip son únicos en toda la sesión, sumando clips de audio y
              clips MIDI (duplicate_id)
start_beat    número 0..5200. Posición del clip en la sesión, en beats
length_beats  número 0.0625..5200. Largo del clip, en beats
loop          boolean
loop_beats    número 0.0625..5200. Largo del patrón que se repite cuando `loop` es true. Con
              `loop` false se conserva (el editor lo recuerda) pero no se usa
notes         Note[], 0..4096
muted         boolean, OPCIONAL (2026-11-25). true = el clip está silenciado: ninguna de sus
              notas suena al escuchar, al exportar (mezcla, pistas, rango) ni en el MIDI
              exportado, y no cuenta como notas que suenan para el asistente. Ausente = suena.
              Quien escribe el documento lo pone solo cuando es true y siempre después de
              `notes`; `false` se acepta al leer y se normaliza a ausente
```

Note (claves en este orden):

```
pitch      entero 0..127
start      número >= 0 y < length_beats del clip, en beats, relativo al inicio del clip
           (si no, note_out_of_clip)
length     número 0.015625..5200, en beats
velocity   entero 1..127
```

Reglas:

- **Fin de la sesión.** `(start_beat + length_beats) * 60 / bpm <= 1200`, tolerancia 0.001 s (si
  no, `session_too_long`). Subir el tempo nunca lo rompe; bajarlo puede: la operación que cambia
  el `bpm` lo comprueba.
- **Recorte.** Una nota puede pasar del final del clip (`start + length > length_beats`): suena
  hasta el final del clip y ahí empieza su relajación.
- **Repetición.** Con `loop` true el patrón `[0, loop_beats)` se repite desde `start_beat`
  hasta el final del clip. Solo cuentan las notas con `start < loop_beats`; una nota que cruza
  `loop_beats` suena entera dentro de esa vuelta, recortada al final del clip. Con
  `loop_beats >= length_beats` la repetición no cambia nada.
- **Solape de notas.** Dentro de un clip, dos notas del **mismo `pitch`** no se solapan: la
  siguiente empieza en o después del final de la anterior (tolerancia 0.000001 beats). Dos notas
  de igual `pitch` y mismo `start` también son solape. Si no, `note_overlap`. Los editores
  mantienen la regla: la operación que provocaría un solape acorta la nota anterior hasta el
  inicio de la siguiente, y si así quedaría con menos de 0.015625 beats, la quita. Notas de
  distinto `pitch` se solapan libremente (acordes).
- **Orden.** El orden de `notes` no es significativo. `serializeSession` las escribe ordenadas por
  `start` y, a igual `start`, por `pitch`; `parseSession` devuelve ese mismo orden.
- **Silencio.** Un clip con `muted` true sigue ocupando su lugar (se ve, se edita, se mueve y
  cuenta para los topes y para `session_too_long`), pero no suena ni alarga lo que se exporta:
  es el equivalente MIDI de un clip de audio con `active` false fuera de un grupo de tomas. Copiar, duplicar, dividir o
  mover un clip silenciado conserva `muted`. Un Worker anterior a este campo rechaza el
  documento que lo trae (`unknown_field`): el Worker se despliega antes que el Hub.
- **Clips solapados.** Dos clips MIDI de la misma pista pueden solaparse; ambos suenan. Si una
  misma nota suena en los dos, el instrumento la trata como dos notas (dos voces).
- **Topes.** 4096 notas por clip, 256 clips MIDI por pista y 16384 notas en toda la sesión (si
  no, `too_many`).

### 2.5 Tamaño del documento

El tope del documento serializado (UTF-8) pasa de 256 KB a **1048576 bytes (1 MiB)** para v2 y
también para un v1 que se lee. Una nota ocupa unos 60 bytes: 16384 notas son casi 1 MiB, así
que el tope de tamaño puede llegar antes que el de notas; es lo que se informa
(`document_too_large`, 413 `session_too_large` en el Worker). El margen de unos 100 bytes que
recomienda v1 (v1 4.2) sigue igual.

### 2.6 Marker (marca)

```
id      string. Único entre las marcas (espacio de ids propio)
beat    número 0..5200. beat * 60 / bpm <= 1200, tolerancia 0.001 s (si no, session_too_long)
label   string, 0..60 caracteres
kind    "intro" | "verse" | "pre_chorus" | "chorus" | "bridge" | "solo" | "interlude" |
        "break" | "outro" | "marker"
```

- `kind` sigue los nombres de sección de la librería (los mismos que arma el análisis de
  Music.AI en `analysis.ts`); `marker` es una marca suelta, sin sección.
- Una marca de sección empieza en su `beat` y dura hasta la marca siguiente (de cualquier
  `kind`) o hasta el fin de la sesión.
- Dos marcas pueden estar en el mismo beat. `serializeSession` escribe las marcas ordenadas por
  `beat` y, a igual `beat`, por `id`; `parseSession` devuelve ese orden.
- Las marcas las crea el usuario o el resultado de `analyze` (sección 4.2), que el usuario
  acepta.

### 2.9 Chord (acorde de referencia)

```
beat           número 0..5200. Inicio del acorde en la sesión. beat * 60 / bpm <= 1200,
               tolerancia 0.001 s (si no, session_too_long)
length_beats   número > 0 y <= 5200. (beat + length_beats) * 60 / bpm <= 1200 con la misma
               tolerancia
name           string, 1..16 caracteres ("C#m", "A", "F#7", "C/G")
```

- Son acordes **de referencia** (los que sonaron en el audio analizado): no suenan ni se
  exportan. Los guarda el Hub cuando el usuario acepta GUARDAR ACORDES en el resultado de
  `analyze` (4.2) y los usa el asistente del chat (4.3.2) para no sugerir a ciegas.
- Sin ids: la lista completa se reemplaza de una vez (un paso de deshacer).
- `serializeSession` los escribe ordenados por `beat` y, a igual `beat`, por `name`. Pueden
  solaparse (el validador no lo impide).
- Errores: `too_many` (más de 2048), `bad_type`, `out_of_range`, `session_too_long`,
  `unknown_field` (otra clave dentro de un acorde).

### 2.7 Límites (se suman a v1 2.8)

| Límite | Valor |
|---|---|
| Pistas por sesión (audio + instrumento) | 16 |
| Clips MIDI por pista | 256 |
| Notas por clip MIDI | 4096 |
| Notas por sesión | 16384 |
| Zonas por sampler | 64 |
| `state` de un plugin WAM | 16384 bytes |
| Marcas por sesión | 256 |
| `label` de marca | 60 caracteres |
| Acordes por sesión (`chords`) | 2048 |
| `name` de acorde | 16 caracteres |
| Beat máximo (1200 s a 260 BPM) | 5200 |
| Largo mínimo de clip MIDI / de patrón | 0.0625 beats |
| Largo mínimo de nota | 0.015625 beats |
| Tamaño del documento | 1048576 bytes (1 MiB) |

### 2.8 Códigos de `StudioSessionError` (se suman a v1 2.9)

| `code` | Cuándo |
|---|---|
| `unsupported_version` | `version` distinto de 1 y de 2 |
| `unknown_field` | también: un campo de pista que no corresponde a su `kind`, o de instrumento que no corresponde a su `type` |
| `bad_value` | también: `kind`, `type`, `preset`, `plugin_id`, parámetro de lista o `kind` de marca fuera de la lista |
| `unknown_asset` | también: `frozen_asset_id` o `asset_id` de una zona que no está en `assets` |
| `clip_out_of_asset` | también: la ventana de una zona se sale de su audio |
| `session_too_long` | también: un clip MIDI o una marca después de los 1200 s |
| `too_many` | también: clips MIDI, notas (por clip o por sesión), zonas o marcas sobre el tope |
| `duplicate_id` | también: id de clip MIDI repetido (con los de audio) o id de marca repetido |
| `note_out_of_clip` | una nota empieza en o después del final de su clip |
| `note_overlap` | dos notas del mismo `pitch` se solapan en un clip |
| `bad_zone` | una zona con `low_pitch > high_pitch` o `low_velocity > high_velocity` |
| `document_too_large` | el documento serializado supera 1 MiB |

## 3. Rutas del Worker

Las mismas de v1 (v1 3). Cambios:

- `PUT .../session` acepta documentos `version` 1 y 2 con las reglas de la sección 2 de este
  contrato (v2) o de v1 (v1). El tope de cuerpo y de documento guardado es 1 MiB
  (413 `session_too_large`).
- `missing_asset` (v1 4.2) no cambia: se comprueban todos los audios de `assets`, entre ellos
  los congelados y los de las zonas del sampler.
- `POST .../jobs` admite los `kind` nuevos de la sección 4. El cuerpo sigue limitado a 64 KB,
  salvo `chat`, que admite hasta **196608 bytes (192 KB)**. Pasarse: 400 `bad_job`, como en v1.
- Rutas nuevas `GET`/`POST .../studio/_cleanup` para los audios huérfanos (3.1).

Objetos en R2 que se suman a v1 3.1 (Worker 1.2.0, interno: ningún cliente los lee ni las rutas
los exponen):

- `studio/_events/AAAA-MM-DD/<HHMMSSmmm>-<8 hex>.json`, en la raíz del bucket: registro de eventos
  de los trabajos (terminados, rechazados por el proveedor y fallos de sondeo o copia), sin
  prompt, letras, audio ni claves; 30 días de retención. Lo lee el MCP de operador (`POST /mcp`).
  Forma en `bandait-stems-worker/README.md`, "Registro de eventos".
- El registro de un trabajo (`studio/<session>/jobs/<job>.json`) guarda además
  `urit_request_id` cuando el proveedor es URiT IA. La respuesta de `GET .../jobs/{job}` (v1 6.5
  y 4.5 de este contrato) no cambia.

### 3.1 Limpieza de audios huérfanos (Worker 1.4.0)

Un audio `studio/<session>/assets/<file>` de una banda (o del workspace personal
`users/<uuid>`) es **huérfano** cuando se cumplen las tres condiciones:

1. El `session.json` de su sesión no lo nombra: ni en `assets[]` (por `file` o por `id`) ni en un
   clip, una zona del sampler o un `frozen_asset_id`. Una carpeta de sesión sin `session.json` no
   protege ninguno de sus audios.
2. Ningún trabajo de su sesión está en curso: un registro en `jobs/` con estado distinto de
   `SUCCEEDED` y `FAILED` (o ilegible) protege **toda** la sesión. Eso cubre el fragmento
   `audio.asset_id` de un `chat` que aún corre y las salidas que un trabajo está copiando.
3. Tiene más de **2 horas**: la fecha de subida de R2 (`uploaded`) o, si existe y es posterior,
   `customMetadata.created_at`.

Reglas de seguridad (normativas):

- Nada se borra de una banda hasta leer **todas** sus sesiones. Si una lectura falla (R2 lanza, o
  un `session.json` no es JSON o no tiene `assets` y `tracks` como listas), no se borra nada de
  esa banda.
- Si el tope de operaciones de R2 no alcanza para leer la banda entera, tampoco se borra nada.
- Antes de borrar se vuelve a pedir el etag de cada `session.json` con candidatos; si cambió, esa
  sesión se salta.
- Un audio referenciado nunca se borra. Si el Hub vuelve a usar un audio que se borró (deshacer),
  el siguiente `PUT .../session` responde 409 `missing_asset` y el Hub sube de nuevo los audios
  desde el equipo (comportamiento ya existente).
- Matiza v1 4.2 ("guardar no borra audios que dejaron de estar listados"): el `PUT` en sí sigue
  sin borrar nada, pero después de responder corre la limpieza oportunista de abajo, que sí borra
  los huérfanos de más de 2 horas de esa sesión.

Rutas:

| Método y ruta | Quién | Respuesta |
|---|---|---|
| `GET /v1/bands/{band}/studio/_cleanup` | integrante | inspección, sin borrar |
| `POST /v1/bands/{band}/studio/_cleanup` | Owner, MusicDirector (la autorización de las escrituras); en `me`, la cuenta dueña | borra los huérfanos |

`{band}` es el uuid o `me`. `_cleanup` no choca con una sesión: los ids que empiezan por `_`
están reservados (v1 3). Otro método: 405 `method_not_allowed`. Las dos responden 200 con:

```json
{"orphans": 3, "bytes": 3145728, "sample": ["ses_a/ast_1.wav"], "sessions": 4,
 "protected_sessions": 1, "complete": true, "blocked": null, "deleted": 3, "deleted_bytes": 3145728}
```

- `orphans` y `bytes`: huérfanos encontrados. `sample`: hasta 20 `<session>/<file>`.
- `sessions`: carpetas de sesión revisadas; `protected_sessions`: saltadas por un trabajo en curso.
- `complete`: false si no se revisó todo; entonces `blocked` es `session_unreadable` (una lectura
  falló) o `incomplete` (no alcanzó el tope de 900 operaciones), y `deleted` es 0.
- `deleted` y `deleted_bytes`: lo borrado (0 en `GET`). Puede ser menor que `orphans` si una
  sesión cambió entre la lectura y el borrado.

Limpieza automática:

- **Cron diario** (`17 4 * * *`, el mismo de la retención de eventos): recorre `bands/` y luego
  `users/`, en orden alfabético, con hasta 860 operaciones de R2 por corrida (con las 40 de la
  retención de eventos, el cron queda en 900). Si no termina, guarda el cursor (última banda
  terminada) en `studio/_cleanup/cursor.json`, en la raíz del bucket, y la corrida siguiente sigue
  desde ahí. Una banda que no cabe en el tope ni con el cupo entero se salta (evento FAILED
  `budget`) para no atascar el barrido.
- **Después de guardar**: tras un `PUT .../session` correcto, en `waitUntil` y sin retrasar la
  respuesta, se limpian los huérfanos de **esa** sesión (hasta 300 operaciones), como mucho una vez
  cada 2 horas por banda. La marca vive en `<prefijo de la banda>studio/_cleanup/last.json` y se
  escribe con condición antes de leer: de dos guardados simultáneos solo uno limpia.

Registro: cada limpieza que borra algo o que se bloquea deja un evento (sección 3, objetos en R2)
con `kind` `cleanup`, `provider` `r2`, `status` `SUCCEEDED` o `FAILED` (`provider_code`
`session_unreadable`, `delete_failed` o `budget`), y además `objects` (audios borrados), `bytes` y
`trigger` (`cron`, `save` o `manual`). Nunca lleva ids de audios. Una inspección no anota nada.

Objetos internos nuevos (ningún cliente los lee): `studio/_cleanup/cursor.json` (raíz),
`studio/_cleanup/last.json` (bajo la banda) y `customMetadata.status` en cada registro de trabajo
(`STARTED`, `SUCCEEDED` o `FAILED`), para que la limpieza no tenga que leer los terminados. Un
registro anterior a 1.4.0, sin esa metadata, se lee.

## 4. Trabajos nuevos

Mismas reglas de v1 para todo trabajo (v1 6): solo Owner y MusicDirector y, si la variable tiene
valor, solo `STUDIO_SPENDER_UIDS` (403 `not_a_spender`); tope de gasto por banda y global
(429 `quota_exceeded`); costo anotado antes de llamar al proveedor y revertido si el proveedor
rechaza; estimación con `?estimate=1`; `job_id` elegido por el Hub con `?job_id=`; el trabajo
**no modifica la sesión**. Lo que devuelve un modelo es una propuesta: el Hub la muestra y el
usuario la acepta, cada aceptación como un paso de deshacer.

| `kind` | Campos | Proveedor | Espera |
|---|---|---|---|
| `compose` | `prompt`, `bpm`, `key`, `beats_per_bar`, `length_bars`, `role`, `context` | `ASSIST_PROVIDER`: `urit` (por defecto) o `gemini` | dentro del `POST`, como `assist` |
| `analyze` | `asset_id`, `duration_s` | Music.AI, workflow `MUSICAI_ANALYZE_WORKFLOW` o, si falta, `MUSICAI_WORKFLOW` | asíncrona, como `separate` |
| `chat` | `messages`, `session_summary`, `tool_mode` | `ASSIST_PROVIDER`: `urit` (por defecto) o `gemini` | dentro del `POST`, como `assist` |

Con `ASSIST_PROVIDER=anthropic`, `compose` y `chat` responden 503 `provider_unavailable` (solo
`assist` lo admite). Con `urit` no se fija modelo: manda la cadena de URiT IA
(`URiT/workers/ai/CONTRACT_V1.md` 3.3). `compose` y `chat` mandan `task` `studio_compose` y
`studio_chat` respectivamente, para el desglose de uso de URiT.

Errores de los trabajos nuevos: los de v1 6.1 (`bad_job` 400, `no_asset` 404, `not_a_spender`
403, `quota_exceeded` 429, `provider_unavailable` 503, `provider_failed` 502, `usage_busy` 503).
No hay códigos nuevos.

### 4.1 `compose`: componer un clip MIDI

```
compose
  prompt          string, 1..1000 caracteres, después de recortar espacios
  bpm             number, 40..260
  key             string | null, 1..12 caracteres ("C#m")
  beats_per_bar   integer, 1..12
  length_bars     integer, 1..64. Largo del clip a componer
  role            "drums" | "bass" | "chords" | "melody"
  context         ContextTrack[], 0..4. Otras pistas, resumidas (puede ir vacío)

ContextTrack
  role            "drums" | "bass" | "chords" | "melody" | "other"
  name            string, 1..60 caracteres
  notes           Note[], 0..256 (forma de 2.4), en beats relativos al inicio del tramo a
                  componer. Entre todas las pistas de contexto, 512 notas como máximo
```

Validación (400 `bad_job`): campo desconocido o ausente, valor fuera de rango, notas de contexto
inválidas o más de 512 en total. Nunca se manda audio.

El Worker pide al modelo JSON con este esquema (`output.format: "json"`, `output.schema`):

```json
{
  "type": "object",
  "properties": {
    "notes": {
      "type": "array",
      "maxItems": 1024,
      "items": {
        "type": "object",
        "properties": {
          "pitch": {"type": "integer", "minimum": 0, "maximum": 127},
          "start": {"type": "number", "minimum": 0},
          "length": {"type": "number", "minimum": 0.015625},
          "velocity": {"type": "integer", "minimum": 1, "maximum": 127}
        },
        "required": ["pitch", "start", "length", "velocity"]
      }
    },
    "description": {"type": "string", "maxLength": 280}
  },
  "required": ["notes", "description"]
}
```

`start` y `length` en beats relativos al inicio del clip. `description`: en español, qué compuso
(una o dos frases). No verificado contra Google si Gemini respeta `maxItems` y `maxLength` del
esquema: por eso el Worker valida la salida igual.

El Worker **normaliza** la salida antes de guardarla, con `L = length_bars * beats_per_bar`:

1. descarta notas con campos inválidos o con `start >= L`;
2. con `role` `drums`, descarta las notas que no están en el mapa GM de 2.3.2;
3. redondea `start` y `length` a 6 decimales y acota `length` para que la nota no pase de `L`;
4. resuelve los solapes del mismo `pitch` con la regla de 2.4;
5. se queda con las primeras 1024 notas ordenadas por `start` y `pitch`.

Resultado (`GET .../jobs/{job}`):

```
{"job_id", "kind": "compose", "status": "SUCCEEDED", "notes": Note[], "length_beats": L,
 "description": string, "cost_usd": number}
```

`notes` va ordenada y sin solapes; el Hub la valida otra vez y la agrega como un clip MIDI nuevo
de `length_beats` (`loop` false, `loop_beats` = `length_beats`) en la pista y el beat que elige
el usuario. Si después de normalizar no queda ninguna nota, el trabajo es `FAILED` con "El
modelo no devolvió notas que se puedan usar. Prueba otra descripción." (el costo queda: el
modelo respondió). Respuesta bloqueada, JSON ilegible tras toda la cadena o respuesta cortada
(`finish_reason` `max_tokens`): `FAILED` con un texto en español, como `assist`.

### 4.2 `analyze`: analizar un audio

```
analyze
  asset_id     string. Id (sin extensión) de un audio ya subido a assets/ (v1 6.1)
  duration_s   number, > 0 y <= 1200. Como en `separate`: el Worker cobra la mayor entre esta
               y la duración real del audio en R2
```

El Worker manda el audio a Music.AI con el workflow `MUSICAI_WORKFLOW` (el mismo del análisis
de canciones, `POST .../songs/{song}/analysis`) y arma el resultado con el mismo ensamblador
(`analysis.ts`). Sin `MUSICAI_API_KEY`: 503 `provider_unavailable`.

Estados: `STARTED` mientras Music.AI trabaja; no hay `IMPORTING` (no deja audios). Resultado:

```
{"job_id", "kind": "analyze", "status": "SUCCEEDED", "analysis": Analysis, "cost_usd": number}

Analysis
  bpm             number | null, 40..260 si viene
  key             string | null, 1..12 caracteres
  beats_per_bar   integer, 1..12 (4 si Music.AI no lo informa)
  downbeat_s      number | null. Segundo del primer tiempo fuerte (inicio del primer compás)
                  dentro del audio
  markers         AnalysisMarker[], 0..256
  chords          AnalysisChord[], 0..2048

AnalysisMarker
  time_s          number >= 0, dentro del audio
  label           string, 0..60 caracteres ("Coro")
  kind            kind de marca de 2.6

AnalysisChord
  start_s         number >= 0, dentro del audio
  end_s           number > start_s
  name            string, 1..16 caracteres ("C#m", "A", "F#7")
```

Los tiempos van en **segundos dentro del audio**, no en beats: el Hub los convierte al aceptar,
con la posición del clip que usa ese audio y el `bpm` de la sesión
(`beat = (start_s_del_clip + time_s - offset_s_del_clip) * bpm / 60`). Aceptar puede proponer
también el `bpm`, la `key` y el `beats_per_bar` de la sesión, cada uno como un paso de
deshacer aparte. Los acordes se muestran como guía y, si el usuario acepta GUARDAR ACORDES, se
guardan en `chords` del documento (2.9), convertidos a beats con la misma fórmula (`length_beats`
desde `end_s - start_s`), recortados a la ventana del clip y reemplazando los anteriores, en un
paso de deshacer. Si después se aplica el tempo del análisis, los acordes guardados desde ese
análisis se recalculan con el tempo nuevo en el mismo paso (siguen al audio, como las marcas).

Costo: `duration_s / 60 * STUDIO_RATE_ANALYZE_USD_PER_MIN` (por defecto 0.3).

### 4.3 `chat`: asistente que opera el Estudio

`chat` **no ejecuta nada**. Devuelve el texto del modelo y las llamadas a herramientas tal como
las pidió. El Hub las muestra; el usuario aplica o rechaza cada una (cada aplicación es un paso
de deshacer, con el mismo registro de comandos que el teclado y la paleta); el Hub manda el
resultado en el turno siguiente.

```
chat
  messages          ChatMessage[], 1..40. El primero es de `user`; el último es de `user` o de
                    `tool`
  session_summary   SessionSummary (4.3.2)
  tool_mode         "auto" | "none". Opcional, "auto" por defecto. Con "none" el modelo solo
                    puede responder texto (cierre del bucle; URiT 3.2)
```

Estimación (`?estimate=1`) de un `chat`: además de los campos de v1 6.6 responde
`"listen": boolean`, `true` solo si el Worker tiene `STUDIO_CHAT_LISTEN` = `"1"` (4.3.5). El Hub
muestra ESCUCHAR FRAGMENTO solo si una estimación de esa conversación dijo `true`.

#### 4.3.1 Mensajes

```
{"role": "user",  "text": string 1..4000, "audio": Listen (opcional, 4.3.5)}
{"role": "model", "text": string 1..8000 | null, "tool_calls": ToolCall[] 0..16}
{"role": "tool",  "tool_results": ToolResult[] 1..16}

ToolCall
  id          string, ^call_[A-Za-z0-9_-]{1,40}$. Lo pone el Worker; único en su respuesta
  name        string, nombre de herramienta (4.3.3)
  arguments   objeto JSON, tal como lo pidió el modelo (claves snake_case del esquema)
  signature   string | null, hasta 32768 caracteres. Firma opaca del proveedor (URiT 3.2);
              null si el proveedor no la dio

ToolResult
  call_id     string, el `id` de la llamada que responde
  name        string, el `name` de esa llamada
  response    {"status": "applied" | "rejected" | "failed", "message": string 0..500}
```

Reglas de la conversación (si no se cumplen, 400 `bad_job`):

- Un mensaje `model` trae `text` no nulo, o al menos una `tool_call`, o los dos.
- Un mensaje `model` con `tool_calls` va seguido **inmediatamente** de un mensaje `tool` con
  exactamente un `tool_result` por llamada, en el mismo orden, con el mismo `call_id` y `name`.
  Un mensaje `tool` solo puede ir después de un `model` con llamadas.
- El Hub devuelve los mensajes `model` **tal como los recibió** del Worker, `signature`
  incluida, sin tocar `arguments` (no los traduce a camelCase).
- `response.status`: `applied` (el usuario aplicó el cambio), `rejected` (lo rechazó), `failed`
  (no se pudo aplicar: herramienta desconocida, argumentos inválidos o el cambio rompería el
  contrato). `message` explica en español, para el modelo, qué pasó.

Traducción a URiT (`/v1/text`, URiT 3.1), que hace el Worker:

| Mensaje del Hub | Mensaje hacia URiT |
|---|---|
| `user` | `{"role": "user", "parts": [{"text": text}]}`; con `audio` en el ÚLTIMO mensaje `user`, se agrega después del texto `{"inline": {"mime_type": "audio/wav" \| "audio/mpeg", "data": base64}}` (4.3.5); con `audio` en un mensaje `user` anterior, una parte de texto que dice que ahí hubo un fragmento ya escuchado |
| `model` | `{"role": "model", "parts": [{"text": text}?, {"tool_call": {"name", "arguments", "signature"}}...]}`; sin `id`; sin `signature` si es null |
| `tool` | `{"role": "tool", "parts": [{"tool_result": {"name", "response"}}...]}`; sin `call_id` |

El Worker antepone `session_summary` al **último** mensaje `user` como una parte de texto
("Estado del Estudio: {json}"), manda las herramientas de `fixtures/studio_chat_tools_v2.json`
(`name`, `description`, `parameters`; sin `command_id`) y `tool_mode`.

#### 4.3.2 SessionSummary

Lo que el asistente sabe de la sesión. Nunca audio ni letras. Desde 2026-11-22 lleva además
notas MIDI resumidas, la armonía conocida y las mediciones de mezcla (campos opcionales marcados
abajo: el Hub los omite si no tiene el dato, y un resumen sin ellos es igual al de antes). Hasta
32768 bytes serializado (si no, 400 `bad_job`).

```
SessionSummary
  title           string
  bpm             number
  beats_per_bar   integer
  key             string | null
  length_s        number, fin del último clip activo (audio o MIDI)
  playhead_beat   number >= 0
  selection       {"track_id": string | null, "clip_ids": string[] 0..64,
                   "context": "global" | "timeline" | "piano_roll" | "mixer"}
  loop            {"start_beat": number >= 0, "end_beat": number > start_beat} | null.
                  Opcional: el loop activo del transporte, en beats de la sesión. El Hub lo
                  omite cuando no hay loop (un Worker anterior a este campo rechaza la clave);
                  el Worker acepta también null
  tracks          TrackSummary[], 0..16
  markers         Marker[], 0..256 (forma de 2.6)
  chords          (opcional) [beat, length_beats, name][], 1..256. Acordes guardados en la
                  sesión (2.9), los más cercanos al cabezal, en orden de beat
  song_chart      (opcional) SongChart. Progresión de acordes de la canción del repertorio
                  ligada a la sesión (`song_id`), desde su ficha ChordPro. Nunca la letra
  mix_measured    (opcional) {"fresh": boolean, "master_lufs": number | null,
                  "master_true_peak_db": number | null}. Hay una medición de mezcla hecha en
                  el equipo (ASISTENTE DE MEZCLA o MEDIR MEZCLA); `fresh` false = la sesión
                  cambió después de medir
  master          {"volume_db", "fx": FxSummary[], "reverb": {"decay_s", "return_db"}}

TrackSummary
  id, kind, name, role, volume_db, pan, mute, solo, reverb_send_db
  fx              FxSummary[]
  instrument      {"type", "preset": string | null, "plugin_id": string | null} | null
  clips           [{"id", "start_s", "length_s", "active"}] 0..64. Clips de audio
  midi_clips      [{"id", "start_beat", "length_beats", "loop", "note_count", "pitch_min",
                    "pitch_max", "digest" (opcional), "muted" (opcional)}] 0..64. pitch_min y
                    pitch_max son null sin notas (son el registro del clip). `muted` (2026-11-26)
                    viaja solo en true: el clip está silenciado (2.4), se ve pero no suena. El
                    Worker ya aceptaba claves extra en cada clip, así que no cambia su validación
  mix             (opcional) {"lufs": number | null, "true_peak_db": number | null,
                  "bands": {"low_db", "low_mid_db", "high_mid_db", "high_db"} | null,
                  "volume_db": number}. Medición de la pista sola (v1 6.3); `volume_db` es
                  el fader que tenía al medir. Solo con `mix_measured`

MidiDigest (resumen de las notas de un clip; con `loop`, del patrón que se repite)
  span_beats      number. Largo que se resume (loop_beats con loop, si no length_beats)
  pitch_classes   [name, weight][] 0..12. Clases de altura ("C", "C#", ... "B") con su peso
                  (fracción de la duración total, 2 decimales), de mayor a menor. Vacío en una
                  pista de batería
  hits            (solo batería) [pitch, count][] 0..16. Golpes por nota General MIDI
  notes_per_bar   number, 1 decimal. Densidad
  grid            "1/4" | "1/8" | "1/8t" | "1/16" | "1/16t" | "1/32" | "libre". La rejilla más
                  gruesa en la que caen al menos el 90 % de los inicios de nota
  velocity_mean   integer 1..127, o null sin notas
  notes           (opcional) [pitch, start_beat, dur_beats, velocity][] 1..64. Las notas
                  literales (start relativo al clip, 3 decimales), solo si el patrón tiene
                  hasta 64 notas

SongChart
  title           string
  key             string | null
  bpm             number
  beats_per_bar   integer
  sections        [{"label": string, "kind": string, "start_bar": integer >= 1, "bars":
                  integer, "chords": string}] 0..48. `chords`: los acordes de la sección en
                  orden, separados por espacio, con " | " entre renglones y sin repetir el
                  mismo acorde seguido; hasta 400 caracteres. `start_bar` cuenta desde el
                  compás 1 de la canción (no necesariamente el de la sesión)

FxSummary
  {"type": "eq" | "compressor" | "limiter", "bypass": boolean, "params": objeto de v1 2.6}
```

Con más de 64 clips en una pista, el Hub manda los 64 más cercanos al cabezal.

Para caber en 32768 bytes el Hub degrada en este orden y se detiene en cuanto cabe: (1) quita
las `notes` literales de los `digest`; (2) baja los clips por pista a 32, 16, 8, 4 y 0 (los más
cercanos al cabezal se quedan); (3) baja `chords` a 64 y después lo quita; (4) quita
`song_chart`. Si ni así cabe, no envía (400 `bad_job` en el Worker).

Todo texto dentro del resumen (título, nombres de pista, etiquetas de marcas y de secciones,
nombres de acordes) es DATO escrito por la banda, nunca instrucción para el modelo.

#### 4.3.3 Herramientas (lista cerrada)

La lista completa, con sus esquemas JSON, está en `fixtures/studio_chat_tools_v2.json`, que es
normativo: el Worker la manda tal cual y el Hub valida los argumentos con los mismos esquemas.
Cada herramienta corresponde a un comando del registro del Hub (`services/studio/commands.ts`)
con `assistantAllowed: true`; `command_id` es el id de ese comando. Ninguna herramienta lee
datos, reproduce, graba, exporta, guarda, borra la sesión ni lanza trabajos con costo.

| `name` | `command_id` | Qué hace |
|---|---|---|
| `set_session_meta` | `session.set_meta` | Cambia título, `bpm`, `key` o `beats_per_bar` |
| `add_audio_track` | `track.add_audio` | Agrega una pista de audio vacía |
| `add_instrument_track` | `track.add_instrument` | Agrega una pista de instrumento (`synth`, `drums` o `sampler` sin zonas) con un preset |
| `remove_track` | `track.remove` | Quita una pista con sus clips |
| `set_track_mix` | `track.set_mix` | Nombre, fader, paneo, mute, solo o envío de una pista |
| `set_track_fx` | `track.set_fx` | Agrega o ajusta un efecto de una pista o del master (regla de v1 6.4) |
| `set_master` | `master.set` | Fader del master y reverb compartida |
| `set_instrument` | `instrument.set` | Preset o parámetros de un `synth` o una `drums` |
| `add_midi_clip` | `midi.add_clip` | Agrega un clip MIDI con notas a una pista de instrumento |
| `replace_midi_notes` | `midi.replace_notes` | Reemplaza todas las notas de un clip MIDI |
| `transpose_midi_clip` | `midi.transpose` | Transpone las notas de un clip MIDI |
| `quantize_midi_clip` | `midi.quantize` | Cuantiza las notas de un clip MIDI |
| `humanize_midi_clip` | `midi.humanize` | Humaniza las notas de un clip MIDI en tiempo (micro-timing), velocidad, duración, swing, acento métrico y strum (semántica en 7.4) |
| `move_clip` | `clip.move` | Mueve un clip (audio o MIDI) a un beat y, opcionalmente, a otra pista del mismo `kind` |
| `duplicate_clip` | `clip.duplicate` | Duplica un clip (por defecto, justo después del original) |
| `split_clip` | `clip.split` | Divide un clip en un beat |
| `delete_clip` | `clip.delete` | Borra un clip |
| `set_clip_gain` | `clip.set_gain` | Ganancia de un clip de audio |
| `add_marker` | `marker.add` | Agrega una marca |
| `remove_marker` | `marker.remove` | Quita una marca |
| `auto_master_session` | `master.auto` | Aplica cadena de masterización DSP local sobre el bus master por perfil LUFS/dBTP |
| `unmask_mix_tracks` | `mix.unmask` | Ejecuta el optimizador matemático anti-enmascaramiento espectral en bandas Bark |
| `generate_click_guide` | `studio.click_guide` | Genera pista de metrónomo acentuado alineada al compás y estructura |

Reglas de aplicación en el Hub:

- Los valores numéricos fuera de rango se acotan al límite (como `sessionOps`); un id inexistente,
  una pista de `kind` equivocado o un resultado que rompería el contrato responden `failed` con
  el motivo.
- En `move_clip`, `duplicate_clip` y `split_clip` sobre un clip de audio, el beat se convierte
  a segundos con el `bpm` de la sesión.
- Las notas de `add_midi_clip` y `replace_midi_notes` se normalizan con la regla de solape de 2.4
  antes de aplicarse.
- Una llamada con `name` fuera de la lista se responde `failed` ("Herramienta desconocida"), sin
  mostrarla como aplicable.

#### 4.3.4 Resultado

```
{"job_id", "kind": "chat", "status": "SUCCEEDED", "reply": string | null,
 "tool_calls": ToolCall[] 0..16, "cost_usd": number}
```

- `reply` es el texto del modelo (`output.text` de URiT), o `null` si vino vacío.
- `tool_calls` son las llamadas tal como las pidió el modelo, **todas**, con `id` puesto por el
  Worker (`call_1`, `call_2`...). El Worker no descarta llamadas de nombre desconocido ni
  argumentos inválidos: quitarlas rompería la cadena de firmas; el Hub las responde `failed`.
  Más de 16 llamadas en una respuesta: `FAILED` ("El asistente pidió demasiados cambios a la
  vez.").
- `reply` null y `tool_calls` vacío a la vez: `FAILED` ("El asistente no respondió.").
- Con `tool_mode` `none`, `tool_calls` siempre es `[]`.
- Bloqueo (502 `blocked` de URiT), JSON ilegible tras toda la cadena (502 `invalid_output`) o
  respuesta cortada (`finish_reason` `max_tokens`): `FAILED` con un texto en español; la consulta
  llegó al modelo y el costo queda.
- Un error del proveedor que no se cobra (502 `provider_error`, 504 `time_budget_exhausted`,
  429, red, o la espera propia del Worker de `time_budget_ms` + 5 s, es decir 75 s) **no** es
  `FAILED`: el `POST` responde HTTP 502 `provider_failed` (o 503 `provider_unavailable` si es
  configuración), la reserva del gasto se revierte y no queda registro del trabajo. El Hub lo
  muestra como error del intento y puede repetir el mismo turno; si reusa el `job_id`, se lanza
  una consulta nueva (el registro no existe). Igual en `compose`.

Para el siguiente turno el Hub agrega el mensaje `model` (`text` = `reply`, `tool_calls` tal
cual) y, si hubo llamadas, el mensaje `tool` con sus resultados, y lanza otro `chat` (otro
`job_id`, otro costo). Después de 8 vueltas seguidas con herramientas sin un mensaje del usuario,
el Hub manda `tool_mode` `none`.

#### 4.3.5 Escuchar a pedido (detrás de `STUDIO_CHAT_LISTEN`)

El músico puede adjuntar a su mensaje un fragmento corto de la mezcla para que el modelo lo
escuche. **Hoy URiT IA no acepta audio en `/v1/text`** (solo imágenes en `/v1/vision`): esta
parte queda lista del lado de Bandait y apagada (`STUDIO_CHAT_LISTEN` = `"0"`). Lo que URiT
tiene que cambiar está en `docs/PLAN_ESTUDIO_V2.md`, anexo "Escuchar a pedido".

```
Listen
  asset_id     string, id (sin extensión) de un audio ya subido a assets/ de la sesión con
               PUT .../assets/<asset_id>.wav (o .mp3). No hace falta que esté en el documento
  duration_s   number, > 0 y <= 30
```

- Formato que sube el Hub: WAV PCM 16 bit, mono, 16000 Hz, hasta 30 s (960044 bytes con la
  cabecera). No cabe en el cuerpo del `chat` (192 KB) ni en el de URiT `/v1/text` (256 KB) como
  base64, por eso viaja como referencia: el Hub lo sube antes con la ruta de audios de la sesión
  (v1 3) y el Worker lo lee de R2.
- El Worker acepta un `audio` solo si `STUDIO_CHAT_LISTEN` vale `"1"`. Si no: 503
  `provider_unavailable` con `"detail": "listen_disabled"` en el cuerpo del error, también al
  estimar. El Hub lo muestra como "Escuchar fragmentos no está habilitado".
- Solo se adjunta el audio del **último** mensaje `user`; los anteriores van como una parte de
  texto ("Aquí el músico adjuntó un fragmento de audio de N s, que ya escuchaste."), para no
  pagar dos veces el mismo audio.
- El Worker busca `assets/<asset_id>.wav` y `.mp3`: si no existe, 404 `no_asset`; si pesa más de
  1048576 bytes, 400 `bad_job`. Lo manda a URiT como parte `inline` con `mime_type`
  `audio/wav` o `audio/mpeg` y los bytes en base64, después del texto del mensaje.
- Costo: `STUDIO_RATE_CHAT_LISTEN_USD` (0.002 por defecto) más, cuando el último mensaje `user`
  trae `audio`. Precio de referencia: lo fija URiT cuando habilite audio.
- El fragmento queda en `assets/` como audio sin referencia en el documento (el MCP de operador
  lo cuenta como huérfano). No se borra solo.

### 4.4 Costos

Se suman a v1 6.6 y 6.7. Tarifas de referencia, sobreescribibles por variable:

| `kind` | Costo estimado | Variable | Por defecto |
|---|---|---|---|
| `compose` | por consulta | `STUDIO_RATE_COMPOSE_USD` | 0.05 |
| `analyze` | por minuto de audio | `STUDIO_RATE_ANALYZE_USD_PER_MIN` | 0.8 |
| `chat` | por consulta (cada vuelta), más un recargo por tamaño | `STUDIO_RATE_CHAT_USD` y `STUDIO_RATE_CHAT_USD_PER_32KB` | 0.03 y 0.015 |
| `chat` con fragmento de audio (4.3.5) | recargo por vuelta que escucha | `STUDIO_RATE_CHAT_LISTEN_USD` | 0.002 |
| `generate` con `lyria` | por canción (v2 4.6) | `STUDIO_RATE_LYRIA_CLIP_USD` (hasta 30 s) y `STUDIO_RATE_LYRIA_SONG_USD` (más de 30 s) | 0.04 y 0.08 |

- `analyze`: el workflow por defecto (`MUSICAI_WORKFLOW`, `stems-workflow-releven-bandait`)
  también separa stems, así que la tarifa por defecto es la de `separate` (0.50) más el análisis
  (0.30). Con un workflow solo de análisis en `MUSICAI_ANALYZE_WORKFLOW` conviene bajarla.
- `chat`: `STUDIO_RATE_CHAT_USD` más `STUDIO_RATE_CHAT_USD_PER_32KB` por cada 32 KB completos de
  `[messages, session_summary]` serializado: una conversación larga gasta más tokens de entrada.
- Costo real: cuando URiT IA informa `usage.estimated_usd` (`compose`, `chat` y `generate`), la
  entrada del gasto y el `cost_usd` del trabajo se ajustan a ese valor después de la respuesta;
  la reserva previa sigue usando la estimación. Si el ajuste sube, el total puede quedar sobre el
  tope: es gasto ya hecho.

La entrada del gasto del mes (v1 6.7) usa `provider` `urit`, `gemini` o `musicai`, y `seconds`
0 en `compose` y `chat`.

### 4.5 Resultado por `kind` en `GET .../jobs/{job}` (se suma a v1 6.5)

```
{"job_id", "kind": "compose", "status": "SUCCEEDED", "notes", "length_beats", "description", "cost_usd"}
{"job_id", "kind": "analyze", "status": "SUCCEEDED", "analysis", "cost_usd"}
{"job_id", "kind": "chat",    "status": "SUCCEEDED", "reply", "tool_calls", "cost_usd"}
```

`STARTED` y `FAILED` como en v1. En estos tres no hay `IMPORTING`.

En `analyze`, si una salida JSON de Music.AI no se puede descargar en ese momento (red o 5xx), el
`GET` responde `STARTED` sin cerrar el trabajo y el siguiente `GET` la vuelve a pedir. Un
análisis con una forma que el Worker no puede leer deja el trabajo `FAILED` ("Music AI devolvió
un análisis que no se pudo leer.").

### 4.6 `generate` con Lyria por URiT IA (cambia v1 6 y 8)

Desde el 2026-11-19 el proveedor `lyria` de `generate` no llama a la Gemini API directa: pasa
por URiT IA, `POST {URIT_AI_URL}/v1/music` (URiT `CONTRACT_V1.md` 4A), con el mismo secreto
`URIT_AI_TOKEN` y las mismas cabeceras que el texto. El Worker ya no necesita `GEMINI_API_KEY`
para generar. El cuerpo de `POST .../jobs` no cambia.

| Pedido | Modelo | Lo que entrega |
|---|---|---|
| `duration_s` de 5 a 30 | `lyria-3-clip-preview` (`LYRIA_CLIP_MODEL`) | un clip de **30 s** siempre: un pedido de 5 a 29 s devuelve 30 s |
| `duration_s` de 31 a 240 | `lyria-3.5` (`LYRIA_SONG_MODEL`) | una canción; la duración se pide en el texto y Lyria la toma como indicación, no como dato exacto |

- Lyria no recibe duración, BPM ni tonalidad como parámetros (URiT responde 400 a un campo
  desconocido): el Worker los agrega al texto del pedido ("Tempo: 128 BPM.", "Key: C#m.",
  "Duration: about 2 minutes." solo en el modelo de canciones, "Instrumental only, no vocals.").
  El usuario puede escribir marcas de sección (`[Verse]`, `[Chorus]`) o de tiempo
  (`[0:00 - 0:10]`) en su descripción.
- Cuerpo hacia URiT: `{"task": "studio_generate", "model", "prompt", "time_budget_ms": 85000}`.
  Espera propia del Worker: 90 s. El audio llega en `output.audio` (`mime_type`, `data` en
  base64, `bytes`); el formato se decide por los primeros bytes y, si no se reconocen, por
  `mime_type`.
- Costo: por canción (tabla de 4.4), ajustado a `usage.estimated_usd`.

| Respuesta de URiT | Resultado |
|---|---|
| 200 con audio legible | `SUCCEEDED` con el audio en `assets` |
| 200 sin audio legible | `FAILED` ("El audio de Lyria no se pudo leer."), con costo |
| 401, 403, 503, 422 `model_not_allowed` | `POST` 503 `provider_unavailable`, sin costo ni registro |
| 429 | `FAILED` con un texto de cuota agotada; costo 0 |
| 502 `blocked` | `FAILED` con el motivo (filtro de seguridad de Google); costo 0 |
| 502 `provider_error` con `detail` `NO_AUDIO` | `FAILED` ("Lyria no devolvió audio."); costo 0 |
| 504 `time_budget_exhausted`, o la espera de 90 s del Worker | `FAILED` ("Lyria tardó demasiado..."); URiT lo cuenta como cobrado y el Worker también |
| otro error (400, 413, 5xx, 502 `provider_error`, red) | `POST` 502 `provider_failed`, sin costo ni registro |

## 5. Variables del Worker (se suman a v1 8)

| Nombre | Tipo | Uso |
|---|---|---|
| `STUDIO_RATE_COMPOSE_USD` | variable | tarifa de `compose` |
| `STUDIO_RATE_ANALYZE_USD_PER_MIN` | variable | tarifa de `analyze` |
| `STUDIO_RATE_CHAT_USD` | variable | tarifa de `chat` por vuelta |
| `STUDIO_RATE_CHAT_USD_PER_32KB` | variable | recargo de `chat` por cada 32 KB completos |
| `STUDIO_RATE_LYRIA_CLIP_USD`, `STUDIO_RATE_LYRIA_SONG_USD` | variables | tarifa de `generate` con Lyria, por canción (reemplazan a `STUDIO_RATE_LYRIA_USD_PER_30S` de v1) |
| `MUSICAI_ANALYZE_WORKFLOW` | variable | workflow de `analyze`; vacío: `MUSICAI_WORKFLOW` |
| `STUDIO_CHAT_LISTEN` | variable | `"1"` acepta fragmentos de audio en el chat (4.3.5); cualquier otro valor, no. En `wrangler.jsonc` vale `"0"` |
| `STUDIO_RATE_CHAT_LISTEN_USD` | variable | recargo de `chat` cuando escucha un fragmento |

`compose` y `chat` usan las mismas variables del proveedor que `assist` (`ASSIST_PROVIDER`,
`URIT_AI_TOKEN`, `URIT_AI_URL`, `URIT_AI_CONSUMER`, `ASSIST_API_KEY`, `ASSIST_MODEL` solo con
`gemini`); `generate` con Lyria usa `URIT_AI_TOKEN`, `URIT_AI_URL` y `URIT_AI_CONSUMER` (4.6);
`analyze` usa `MUSICAI_API_KEY` y `MUSICAI_ANALYZE_WORKFLOW` o `MUSICAI_WORKFLOW`.
`GEMINI_API_KEY` queda solo como alternativa del asistente de texto (`ASSIST_PROVIDER`
`gemini`). El navegador nunca recibe ninguna clave.

## 6. Fuera de este contrato

- Mapa de tempo y cambios de compás dentro de una sesión.
- Automatización de parámetros.
- VST nativos (plan, sección 8). El lugar del congelado (`frozen_asset_id`) ya está reservado.
- Lyria en tiempo real (`lyria-realtime-exp`, WebSocket) y salida WAV de `lyria-3.5`: URiT no las
  ofrece todavía.

## 7. Colaboración, Control de Versiones (`/vcs`) y Extensiones DSP (v2 extendido)

### 7.1 Permisos colaborativos en `/v1/bands/{band}/studio`
- **Lectura** (`GET .../studio`, `GET .../session`, `GET .../assets/{asset}`, `GET .../jobs/{job}`, `GET .../vcs`, `GET .../commits/{commit}`, `GET .../_cleanup`): cualquier integrante de la banda.
- **Edición colaborativa de estudio** (`PUT .../session`, `PUT .../assets/{asset}`, `POST .../vcs`): roles `Owner`, `MusicDirector`, `Musician` y `SoundEngineer` (`STUDIO_COLLABORATORS`). El rol `Substitute` permanece en solo lectura.
- **Administración y gasto de IA** (`DELETE .../studio/{session}`, `DELETE .../vcs/branches/{branch}`, `POST .../_cleanup`, `POST .../jobs`): exclusivo de `Owner` y `MusicDirector` (`EDITORS`).

### 7.2 Control de versiones en R2 (`vcs.json` y `commits/`)

Cambios del Worker 1.5.1 (2026-11-27): `parent_id` normativo, tope de ramas, borrado de rama,
`retired_assets`, autor verificado y `vcs_conflict` pasa de 412 a 409.

```
VcsIndex {
  version           1
  branches          { [rama]: commit_id }      rama ^[A-Za-z0-9_-]{1,40}$, hasta 16
  commits           VcsCommitMeta[]            del más nuevo al más viejo
  protected_assets  string[]                   NOMBRES de archivo de assets/ (no ids)
  retired_assets    { file, until }[]          1.5.1; ausente en índices anteriores = []
}

VcsCommitMeta {
  id, branch, parent_id (string | null), message, author_id (sub del token | null),
  author_name, created_at, track_count, bpm, key (string | null), asset_files string[]
}
```

- `GET /v1/bands/{band}/studio/{session}/vcs`: devuelve el `VcsIndex` (vacío si aún no hay commits), con cabecera `ETag` cuando existe. Un lector viejo ignora `retired_assets`.
- `POST /v1/bands/{band}/studio/{session}/vcs`: cuerpo `{ branch: string, message: string, parent_id?: string | null, author_name?: string, session: SessionDocument }` (hasta 1 MiB + 64 KiB; más es 413 `session_too_large`). Valida `session` (400 `bad_session`), verifica que sus `assets` existan en R2 con su tamaño (409 `missing_asset`), escribe el snapshot inmutable en `studio/<session>/commits/<commit_id>.json` (409 `commit_conflict` si el id ya existe) y actualiza `vcs.json` con escritura condicional (`etagMatches`). Responde 201 `{ commit, vcs }`.
  - **`parent_id`**: ausente, el commit se encadena a la cabeza actual de la rama. Presente, debe ser la cabeza actual (`null` = la rama todavía no existe); si no, 409 `vcs_conflict` y no se escribe nada. El Hub, ante 409 `vcs_conflict`, vuelve a leer el índice y reintenta una vez con la cabeza nueva.
  - **Carreras**: si `vcs.json` cambió entre la lectura y la escritura, el Worker relee y reintenta hasta 3 veces; si sigue perdiendo, 409 `vcs_conflict` y borra el snapshot que había escrito.
  - **`author_name`**: sale de la identidad verificada (token de Supabase: `user_metadata.full_name`, `user_metadata.name` o la parte local del correo; `Integrante` si no hay nada). El campo del cuerpo se acepta y se ignora.
  - **Topes**: se retienen 128 commits; las cabezas de rama nunca se expulsan (como mucho 128 + 16 entradas). Hasta 16 ramas: un commit que crearía la 17.ª es 409 `too_many_branches`. Si el índice pasa de 1 MiB se expulsan commits viejos que no son cabeza hasta que quepa. Los documentos de los commits expulsados se borran.
- `DELETE /v1/bands/{band}/studio/{session}/vcs/branches/{branch}` (Owner / MusicDirector): quita la rama y los commits de esa rama que ninguna otra cabeza alcanza por `parent_id`; borra sus documentos. Responde 200 `{ deleted_commits, vcs }`. `main` no se borra (409 `branch_protected`); rama inexistente 404 `no_branch`; nombre inválido 400 `bad_vcs`; carrera perdida 3 veces 409 `vcs_conflict`.
- `GET /v1/bands/{band}/studio/{session}/commits/{commit}`: devuelve el `SessionDocument` guardado en ese commit. `{commit}` sin el patrón de id es 400 `bad_commit`; inexistente 404 `no_commit`.
- **Protección de audios**: `protected_assets` = archivos de todos los commits retenidos ∪ `retired_assets` vigentes. Un audio que deja de estar en algún commit retenido (commit expulsado o rama borrada) entra en `retired_assets` con `until` = ahora + 30 días (hasta 4096 entradas; si sobran, salen primero las que vencen antes) y se suelta en la primera escritura del índice después de vencer.
- `studioCleanup.ts` lee `vcs.json` solo en sesiones con candidatos (1 operación R2) y no borra ningún archivo de `protected_assets` (por nombre, y por id = nombre sin extensión). Antes de borrar vuelve a pedir el etag de `session.json` **y** de `vcs.json`; si cualquiera cambió, salta esa sesión. La limpieza oportunista disparada por el guardado de un `Musician` o `SoundEngineer` es conservadora: protege además todo `retired_assets`, aunque haya vencido.
- Un `vcs.json` ilegible es 500 `vcs_corrupt` en `GET`/`POST`/`DELETE` y deja la sesión sin limpiar (`session_unreadable`).

Códigos (se suman a la tabla de errores de v1 7):

| HTTP | `error` | Ruta | Cuándo |
|---|---|---|---|
| 400 | `bad_vcs` | `POST .../vcs`, `DELETE .../vcs/branches/{branch}` | cuerpo no es objeto, rama o mensaje inválidos, `parent_id` mal formado, nombre de rama inválido |
| 400 | `bad_commit` | `GET .../commits/{commit}` | `{commit}` no cumple el patrón de id |
| 404 | `no_commit` | `GET .../commits/{commit}` | el snapshot no existe |
| 404 | `no_branch` | `DELETE .../vcs/branches/{branch}` | la rama no existe |
| 409 | `vcs_conflict` | `POST .../vcs`, `DELETE .../vcs/branches/{branch}` | `parent_id` no es la cabeza actual, o `vcs.json` siguió cambiando tras 3 intentos |
| 409 | `commit_conflict` | `POST .../vcs` | colisión de id al escribir el snapshot |
| 409 | `too_many_branches` | `POST .../vcs` | la sesión ya tiene 16 ramas |
| 409 | `branch_protected` | `DELETE .../vcs/branches/{branch}` | `main` no se borra |
| 500 | `vcs_corrupt` | `GET`/`POST .../vcs`, `DELETE .../vcs/branches/{branch}` | `vcs.json` ilegible o fuera del esquema v1 |

### 7.3 Efectos DSP adicionales, polaridad/curvas de clip y `analog_drift` (solo `version: 2`)
- Nuevos tipos de `fx` admitidos en `version: 2` (hasta 5 efectos en pista, hasta 6 en master con `limiter` de último):
  - `de_esser`: `freq_hz` (`2000..10000`, def `6500`), `threshold_db` (`-48..0`, def `-24`), `reduction_db` (`0..18`, def `6`).
  - `saturator`: `drive_db` (`0..24`, def `6`), `tone_db` (`-12..12`, def `0`), `mix` (`0..1`, def `1`), `output_db` (`-12..12`, def `0`).
  - `stereo_imager`: `width` (`0..2`, def `1`), `mono_bass_hz` (`0..300`, def `120`).
- Campos opcionales en clips de audio (`version: 2`, omitidos en el cable cuando valen el valor por defecto):
  - `phase_invert`: `true` (ausente cuando es `false`).
  - `fade_shape`: `'exp' | 'scurve'` (ausente cuando es `'linear'`).
- Parámetro opcional en instrumentos `synth` y `drums` (`version: 2`):
  - `analog_drift`: `0..1` (def `0`; se omite en el cable cuando vale `0` para identidad exacta con documentos previos).
  - Determinismo de `analog_drift` (cliente, sin cambio en el cable): la deriva de cada nota de un clip se siembra con su posición musical (segundo de sesión de la nota y id de la pista), nunca con la hora del `AudioContext`, así la reproducción y el export suenan igual. Tiene dos capas: tolerancia estática por nota (afinación, corte, decaimiento) y vagabundeo lento continuo de afinación y corte (unos pocos cents a lo largo de segundos), función del tiempo de sesión. Las notas tocadas en vivo, que no tienen posición musical, usan la hora del contexto.

### 7.4 Humanización MIDI y groove (`humanize_midi_clip`)
- `swing` (`0..0.5`): fracción del paso de `swing_grid` (`'1/8'` o `'1/16'`, def la del preset o `'1/16'`) que se atrasa la subdivisión impar: `0.33` = tresillo (66 %), `0.5` = puntillo (75 %). La subdivisión impar se coloca en `rejilla + swing * paso` (idempotente: aplicarlo dos veces no lo suma).
- La fase del acento métrico y del swing es el beat de la sesión (`start_beat` del clip + `start` de la nota), con el compás de la sesión desde el beat 0.
- Tiempos en milisegundos al tempo de la sesión: `timing_ms` (`0..60`) y `strum_ms` (`-60..60`). `timing_beats` y `strum_beats` siguen aceptándose (absolutos en beats); si llegan las dos formas, gana la de ms.
- `amount` escala todo lo que sale del preset (micro-timing, velocidad, duración, swing, strum y acento) en proporción `amount / amount_del_preset`; un valor explícito es absoluto.
- Pista con instrumento `drums`: humanización por pieza General MIDI (bombo y caja más ajustados, hi-hat con más variación de velocidad y acento en corcheas, sin strum). `laid_back_ms` (`0..30`, def `0`) atrasa la caja (notas 38, 39 y 40).
- El "groove de la banda" (plantilla tomada de un clip de audio y aplicada a notas MIDI) es una herramienta local del editor: no viaja ni se guarda en la sesión; lo que queda en el documento son las notas ya movidas.

