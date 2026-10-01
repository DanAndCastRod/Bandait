# Workspace v2: documento hub ↔ líder

Fecha: 2026-10-01. Estado: normativo para la Fase 1. Ejemplo canónico en
`fixtures/workspace_v2.json`; las pruebas del hub y del líder validan contra ese archivo.

El workspace es el JSON que el Web Hub guarda en `public.bandait_workspaces.workspace`
(Supabase, una fila por cuenta, RLS por `auth.uid()`) y en `localStorage`. Desde la
Fase 1 **también lo lee el líder de escritorio**, así que su forma es un contrato. A
diferencia del protocolo de red (CONTRACT_V3, en snake_case), el workspace es un
documento del hub y usa **camelCase**, tal como lo guarda hoy.

Dirección de la sincronización en la Fase 1: **solo hub → líder**. El líder nunca escribe
en la nube. Las ediciones se hacen en el hub.

## 1. Raíz

```
schemaVersion   2                       (ausente = v1)
bands           Band[]                  (sin cambios)
activeBandId    string
membersMap      { [bandId]: BandMember[] }    (sin cambios)
playlistsMap    { [bandId]: Playlist[] }      (PlaylistSong amplía campos, ver 3)
equipmentMap    { [bandId]: EquipmentItem[] } (sin cambios)
stemsMap        { [songId]: SongStems }       (sin cambios)
songsMap        { [bandId]: Song[] }          NUEVO: librería de canciones por banda
voiceMap        { [bandId]: VoiceConfig }     NUEVO: conteos y avisos de voz
_sync           objeto interno del motor de sincronización del hub (no lo usa el líder)
```

Lectores y escritores deben **conservar los campos desconocidos**: un hub más nuevo
puede agregar campos que uno más viejo no conoce.

## 2. Song (librería)

```
id            string, UUID v4. Estable: el líder lo usa como clave al importar.
title         string
artist        string
bpm           number, 40..260
beatsPerBar   integer >= 1 (4 por defecto)
beatUnit      integer (4 por defecto)
key           string, tono original (p. ej. "Am")
camelot       string opcional (p. ej. "8A")
durationSec   number opcional (informativo)
sections      Section[] en orden de interpretación (puede estar vacío)
notes         string opcional
updatedAt     string ISO 8601
```

### Section

```
id         string (UUID v4)
kind       "intro" | "verse" | "pre_chorus" | "chorus" | "bridge" | "solo" |
           "interlude" | "outro" | "break" | "custom"
label      string visible, p. ej. "Estrofa 1", "Coro final"
bars       integer >= 1: duración de la sección en compases
chordpro   string: cuerpo ChordPro de esta sección (puede ser ""). Líneas con
           acordes entre corchetes antes de la sílaba: "[Am]Hoy [F]vuelvo a [C]casa".
           Sin directivas {start_of_*}: la sección ya delimita el bloque.
cueText    string | null | ausente. Aviso hablado antes de la sección:
           ausente -> texto por defecto según `kind` (tabla 5.2); null -> sin aviso;
           string -> ese texto.
```

Reglas:
- **La letra se sincroniza por compases, no por segundos.** El compás 1 de la canción es
  el primer compás de `sections[0]`, y cada sección empieza en
  `start_bar = 1 + suma(bars de las secciones anteriores)`.
- `total_bars = suma(bars)`. Si `sections` está vacío, la canción no tiene final conocido
  y solo admite la transición `manual_cue` (ver 4).

## 3. PlaylistSong (ítem de setlist)

Campos v1 que se mantienen: `id`, `orderIndex`, `title`, `artist`, `bpm`, `key`,
`showKey`, `camelot`, `durationSec`, `transitionMode`, `countInBars`, `notes`.

```
songId         string NUEVO, obligatorio en v2: id de la Song de la librería de la
               misma banda.
bpm            BPM de este show; reemplaza a Song.bpm si difiere.
showKey        tono de este show (informativo en la Fase 1; la transposición
               automática de acordes es opcional en el hub).
transitionMode "manual_cue" | "auto_count_in" | "gapless" (ver 4)
countInBars    integer 0..4: compases de conteo antes del compás 1.
countInVoice   boolean NUEVO, true por defecto: conteo hablado en esos compases.
gapSec         number NUEVO, 0..30, 0 por defecto: pausa antes de un auto_count_in.
```

`title`, `artist` y `key` quedan como copia de respaldo para mostrar; la fuente de verdad
es la Song referida por `songId`.

**Orden:** el orden del setlist es el de `orderIndex` ascendente. El hub numera desde 1 y
el fixture desde 0: los lectores **no deben asumir la base**, solo ordenar. Ante un empate
manda el orden del arreglo.

## 4. Transiciones (las ejecuta el líder; normativo en CONTRACT_V3 §9)

| Modo | Qué hace al terminar la canción anterior |
|---|---|
| `manual_cue` | El transporte se detiene al terminar el último compás; la siguiente queda en cola y el director pulsa PLAY. |
| `auto_count_in` | Tras `gapSec`, arranca solo con `countInBars` de conteo y luego el compás 1. |
| `gapless` | La siguiente canción empieza en el compás inmediatamente posterior al último, sin conteo, con su propio BPM. |

El modo de un ítem describe **cómo se entra a ese ítem**. El primer ítem del setlist
siempre espera PLAY, aunque tenga `countInBars > 0`: PLAY dispara su conteo. Si la canción
anterior no tiene `total_bars` (sin secciones), el líder trata la entrada como
`manual_cue` y lo avisa.

## 5. VoiceConfig (por banda)

```
enabled       boolean
provider      "azure"
voice         "es-CO-SalomeNeural" | "es-CO-GonzaloNeural" (otras voces es-* permitidas)
rate          string de prosodia SSML, "+0%".."+50%"
countIn       boolean: decir los números durante el conteo
sectionCues   boolean: decir el aviso de cada sección
cueLeadBars   1 | 2: cuántos compases antes de la sección suena el aviso
output        "drummer" | "all_in_ear": salida del líder donde suenan (ver CONTRACT_V3 §9)
```

### 5.1 Palabras del conteo

Una palabra por beat, generadas **una por una**: no se sintetiza la frase completa,
porque "Uno. Dos. Tres. Cuatro." dura unos 5.3 s y a 120 BPM los cuatro beats duran 2 s.
Esto se midió con Azure F0 el 2026-10-01. Números "uno".."doce" según `beatsPerBar`.

Duración de la voz recortada, medida el 2026-10-01 (ms):

| Voz / velocidad | Uno | Dos | Tres | Cuatro | Cabe hasta |
|---|---|---|---|---|---|
| Salomé +0% | 259 | 431 | 305 | 392 | ~139 BPM |
| Salomé +35% | 193 | 314 | 226 | 290 | ~191 BPM |
| Gonzalo +0% | 255 | 368 | 356 | 338 | ~163 BPM |
| Gonzalo +35% | 185 | 265 | 260 | 252 | ~226 BPM |

Regla de velocidad:
- Se generan dos variantes de cada palabra: la `rate` configurada y `+35%`.
- En cada conteo, el líder usa la primera variante cuya palabra más larga quepa en el 85 % de un beat.
- Si ninguna cabe, cuenta solo las palabras de los beats impares y deja el clic en los pares.
- El silencio inicial (~100-150 ms) se recorta, para que cada palabra arranque exactamente en su beat.

### 5.2 Aviso por defecto según `kind`

| kind | aviso | kind | aviso |
|---|---|---|---|
| intro | "Intro" | solo | "Solo" |
| verse | "Estrofa" | interlude | "Interludio" |
| pre_chorus | "Pre coro" | outro | "Final" |
| chorus | "Coro" | break | "Corte" |
| bridge | "Puente" | custom | el `label` |

## 6. Migración v1 → v2 (la hace el hub al cargar; debe ser idempotente)

Para cada banda y cada `PlaylistSong` sin `songId`:
1. Buscar en `songsMap[bandId]` una Song con el mismo `title` y `artist` (sin
   distinguir mayúsculas ni espacios extremos).
2. Si no existe, crearla copiando `title`, `artist`, `bpm` (acotado a 40..260),
   `key`, `camelot` y `durationSec`, con `beatsPerBar 4`, `beatUnit 4` y `sections []`.
   - Su `id` es **determinista**: se deriva de banda, título y artista, con formato
     UUID v4.
   - Así dos dispositivos que migran los mismos datos v1 producen el mismo v2, sin falsos
     conflictos de sincronización.
   - Un `songId` que apunta a una canción inexistente se repara recreando la canción con
     ese mismo `id`.
3. Poner `songId`. Completar `countInVoice: true` y `gapSec: 0` si faltan.

Luego `schemaVersion = 2` y `voiceMap[bandId]` por defecto si falta:
`enabled false`, voz Salomé, `+0%`, `countIn true`, `sectionCues true`,
`cueLeadBars 1`, `output "drummer"`.

El líder acepta también v1: trata cada `PlaylistSong` como una canción sin secciones.
