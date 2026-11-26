# Requerimientos de Bandait Web 3.0 (Hub & Estudio DAW)

Este documento consolida los requerimientos funcionales, visuales y de experiencia de usuario para **Bandait Web 3.0** (`bandait-leader-web` y `bandait-stems-worker`), incluyendo los criterios de fidelidad visual del Estudio DAW.

---

## 1. Apariencia Configurable (Cero Botones Cuadrados)

- **Temas base por defecto:** `Dark Grafito` (baja fatiga en escenario/estudio oscuro) y `Light Estudio` (alta legibilidad bajo luz diurna).
- **Color de acento libre con contraste WCAG automático:** selector de color libre + código hexadecimal con cálculo automático de tinta de contraste `--b-on-accent` (`#15181C` o `#FFFFFF`, ratio WCAG >= 4.5:1).
- **Redondez configurable en píxeles:** rango `8px` a `999px` (modo píldora). Prohibido cualquier botón cuadrado (`< 8px`).
- **Transporte siempre circular:** los controles de transporte (`Play`, `Pause`, `Stop`, `Record`) mantienen siempre forma circular (`9999px`) por memoria muscular.
- **Persistencia aislada por músico:** las preferencias (`uiPreferences`) se persisten en `bandait_workspaces` (Supabase) con caché instantánea en `localStorage`, aisladas por usuario y **sin escribir nunca en `bandait_bands.content`**. Un integrante con rol `Musician` de solo lectura en una banda compartida puede personalizar libremente su propia apariencia.
- **Regla visual estricta:** prohibido el uso de iconos emoji en toda la interfaz, artefactos o documentación; usar exclusivamente SVG técnicos normalizados o glifos monocromáticos.

---

## 2. Shell y Navegación Unificada

- **Escritorio (`>= 768px`):**
  - Rail izquierdo minimalista y colapsable (`244px` <-> `72px`) con persistencia de estado.
  - CTA principal prominente `+ Subir o Separar Audio` en el rail.
  - 6 vistas redondeadas en orden:
    1. `Estudio DAW`
    2. `Ensayo y Prompter`
    3. `Canciones y Stems` (absorbe la antigua vista `PISTAS` mediante selector segmentado `LIBRERÍA` | `STEMS Y PISTAS`)
    4. `Setlists`
    5. `Banda`
    6. `Ajustes` (`VOZ Y CONTEOS`, `EQUIPAMIENTO`, `APARIENCIA`)
- **Móvil (`< 768px`):**
  - Barra inferior de **4 píldoras**: `Ensayo`, `Canciones`, `Setlists`, `Más` (despliega hoja secundaria con `+ Subir o Separar Audio`, `Estudio DAW`, `Banda`, `Ajustes`, `Manual`, `Exportar JSON`).
  - **Mini-reproductor flotante** posicionado encima de la barra inferior con acceso directo a `Estudio` en modo escucha/mezcla.

---

## 3. Motor de Audio Global Persistente y Estudio DAW Limpio

- **Audio persistente a nivel global:** el motor de audio (`StemPlayer` y `StudioController`) vive a nivel global en `App.tsx` (`GlobalAudioProvider`), de modo que cambiar de vista nunca detiene ni cierra el `AudioContext`.
- **Protagonismo de Timeline y Piano Roll (`E`):** en `StudioHubView.tsx`, la Línea de Tiempo multipista y el Piano Roll ocupan el área central principal.
- **Consola inferior y Panel lateral plegables a un clic:** `StudioMixer` (consola inferior) y el panel lateral (`Inspector` / `Dispositivo` / `IA`) se muestran u ocultan con un clic.
- **`StudioAssistant` (`Alt+A`):** estrictamente en modo **ventana flotante** arrastrable/redimensionable o **minimizado a píldora** (nunca ocupa una columna fija que estreche el Timeline).

---

## 4. Criterios Obligatorios de Fidelidad DAW (Estudio Actual vs. Maquetas/Rediseño)

Cualquier maqueta, rediseño o iteración visual del Estudio DAW **debe validar y preservar la apariencia, densidad técnica y capacidades reales** ya implementadas en `StudioHubView.tsx`, `StudioTimeline.tsx`, `StudioPianoRoll.tsx`, `StudioMixer.tsx`, `StudioInspector.tsx` y `studio.css`. El Estudio debe verse y operar como un DAW real, no como tarjetas genéricas:

1. **Cabecera y barra de transporte DAW completas:** reloj técnico dual (`COMPÁS.TIEMPO` + `MM:SS.m`), BPM editable con Tap Tempo, métrica/compás, metrónomo con conteo previo, armado de grabación, región de bucle sobre la regla, Deshacer/Rehacer, controles de Snap/Zoom, paleta de comandos (`Ctrl+K`) y atajos.
2. **Timeline multipista real:** regla de compases con marcadores de sección, cabeceras de pista completas (color por rol, `M`, `S`, `R`/Armar, selector de instrumento, fader/paneo rápido), formas de onda reales en clips de audio con tiradores de recorte y fades, clips MIDI con previsualización de notas y playhead vertical continuo atravesando todos los carriles.
3. **Piano Roll completo:** teclado vertical de octavas, cuadrícula de beats y subdivisiones, barra de herramientas (`Seleccionar`, `Dibujar`, `Borrar`, `Cortar`, `Velocidad`), carril inferior de velocidades y acciones de cuantización/transposición.
4. **Consola de mezcla (`StudioMixer`) real:** canales verticales (channel strips) con vúmetros LED peak/RMS por pista, slots de inserción FX (`EQ`, `COMP`), envío a reverb, fader vertical con escala dB real (`+12` a `-60 dB`) y canal Master con lecturas LUFS integrada/momentánea y True Peak.
5. **Densidad técnica coherente:** aplicar la redondez configurable (`8px`–`999px`), los temas (`Dark Grafito` / `Light Estudio`) y el color de acento WCAG respetando la densidad compacta y de alto contraste propia de una consola/DAW profesional, sin "ablandar" ni vaciar el espacio de trabajo.

---

## 5. Funcionalidades Nuevas de Audio y Nube

- **Time-Stretch (`0.50x`–`1.25x`) y Pitch-Shift (`±6 st`) reales en `AudioWorklet`:**
  - Procesador estéreo en tiempo real (`GranularPitchShifter` sobre `AudioWorklet`) integrado en `StemPlayer`.
  - Sincronización bidireccional entre `Pitch-Shift` (`±6 st`) y la transposición de acordes `ChordPro` en `RehearsalHubView`.
  - Modo **`Speed Ramp`** progresivo por vuelta en bucles A-B y bucles de sección.
- **Cola global `Drop & Split` en segundo plano:**
  - Permite encolar la separación con Music.AI e importación a R2 y seguir navegando o trabajando en el Hub/DAW sin abortar el proceso al cambiar de vista.
- **Limpieza automática y manual de fragmentos huérfanos en R2 (`assets/`):**
  - En `bandait-stems-worker`: barrido automático diario (cron 24 h), limpieza oportunista tras guardar sesión (2 h) y endpoints `GET`/`POST /v1/bands/{band}/studio/_cleanup` para inspección y limpieza manual desde la UI, protegiendo siempre los assets referenciados por `session.json` y trabajos activos.
