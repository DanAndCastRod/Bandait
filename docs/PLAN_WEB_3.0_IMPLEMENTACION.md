# Plan de implementación de Bandait Web 3.0 y pulido del Estudio

**Fecha:** 2026-11-25
**Pedido de Daniel Castañeda:** "proceder con el resto de la implementación necesaria para seguir
puliendo el estudio y todas las recomendaciones".
**Fuentes:** `docs/REQUERIMIENTOS_WEB_3.0.md` (requerimientos, escritos por Antigravity el
2026-11-26 UTC) y los pendientes del Estudio en `DEVLOG.md` (entradas del 2026-11-22 y 2026-11-23).

## Estado encontrado (2026-11-25)

Búsqueda en `bandait-leader-web/src` y `bandait-stems-worker/src`: no existe ninguna pieza de
Web 3.0 (`uiPreferences`, temas, acento WCAG, rail, `GlobalAudioProvider`, worklet de tono y
velocidad, Speed Ramp, cola `Drop & Split`, limpieza de huérfanos `_cleanup`). El Hub tiene 7
pestañas (`HubNavbar.tsx`) y `stemPlayer.ts` vive dentro de las vistas.

## Ola 1 (en paralelo, áreas separadas)

| Agente | Alcance | Archivos principales |
|---|---|---|
| Nube | Limpieza de fragmentos huérfanos en R2 `assets/` (cron diario, oportunista tras guardar sesión, `GET`/`POST /v1/bands/{band}/studio/_cleanup`), cliente en el Hub y acción en la interfaz | `bandait-stems-worker/src`, `services/studio/studioCloud.ts` |
| Audio | Worklet de tono y velocidad (0,50x a 1,25x, ±6 semitonos) en `stemPlayer.ts`, Speed Ramp por vuelta en bucles, sincronía del tono con la transposición ChordPro del ensayo | `services/stemPlayer.ts`, `views/RehearsalHubView.tsx`, worklet nuevo |
| Apariencia | Temas Dark Grafito y Light Estudio, acento libre con tinta de contraste WCAG, redondez 8 a 999 px, transporte siempre circular, `uiPreferences` por músico en `bandait_workspaces` con caché local, sección APARIENCIA | `styles/global.css`, `styles/studio.css` (solo tokens), `services/workspace*`, `views/SettingsHubView.tsx` |
| Estudio | Selección por rectángulo, silencio de clips MIDI (contrato), auditoría de la sección 4 de fidelidad DAW y cierre de lo que falte | `components/studio/*`, `services/studio/*`, `bandait-protocol/STUDIO_V2.md` |

## Ola 2 (después de integrar la ola 1)

- Shell: rail izquierdo colapsable (244 / 72 px) con CTA `+ Subir o Separar Audio`, 6 vistas
  (Estudio DAW, Ensayo y Prompter, Canciones y Stems con selector LIBRERÍA | STEMS Y PISTAS,
  Setlists, Banda, Ajustes con VOZ Y CONTEOS, EQUIPAMIENTO, APARIENCIA); en móvil barra de 4
  píldoras con hoja "Más" y mini reproductor.
- `GlobalAudioProvider` en `App.tsx`: `StemPlayer` y `StudioController` sobreviven al cambio de vista.
- Cola global `Drop & Split` en segundo plano.
- Estudio: consola inferior y panel lateral plegables a un clic; el asistente solo flotante o
  minimizado (se retira el modo acoplado, por el requerimiento 3).

## Reglas para todos

Contrato primero si cambia algo que viaja; textos en español y sin emojis; pruebas en los
scripts de `verify:logic`, en el Worker (`npm test`) y en Playwright; los manuales de la app se
reescriben al final (decisión de Daniel Castañeda).
