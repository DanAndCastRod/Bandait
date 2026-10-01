# Guía para Agentes de IA (AGENTS.md) — Bandait 3.0

Este repositorio opera bajo una arquitectura de ingeniería rigurosa para aplicaciones de audio profesional y escenario en vivo.

## 1. FUENTE DE VERDAD ABSOLUTA
Antes de realizar cualquier propuesta, refactorización o edición de código, el agente DEBE leer y alinearse con:
[`docs/PLAN_BANDAIT_3.0_MASTER.md`](docs/PLAN_BANDAIT_3.0_MASTER.md)

Todo acuerdo arquitectónico respecto a:
- Sincronización NTP y fallback Flywheel autónomo
- Ruteo físico ASIO en Python PySide6 (Salidas 1-2 PA, Salida 3 cable a baterista)
- Control remoto concurrente (Laptop + Smartphone del Director)
- Pre-caché de stems en IndexedDB
- Importación/Exportación XLSX multi-pestaña con Diff Preview
- Sistema visual Swiss Bauhaus Lab (`Space Grotesk` + `IBM Plex Mono`) con 4 estilos seleccionables en cliente
está estrictamente especificado y blindado en dicho plan maestro.

## 2. REGLA VISUAL ESTRICTA
- **PROHIBIDO** el uso de iconos emoji en la interfaz de usuario, artefactos HTML, componentes web, QSS o mensajes markdown.
- Utilizar exclusivamente iconos vectoriales SVG técnicos normalizados o glifos tipográficos monocromáticos.

## 3. INDEPENDENCIA DE TEMAS
- La selección de tema visual ocurre en el cliente (`localStorage` del Follower PWA).
- El estado de la red (NTP, Beat, Compás, Transporte, Acordes) NUNCA debe acoplarse con las clases o estilos de renderizado visual.

## 4. VERIFICACIÓN DE PRUEBAS
El CI no enmascara fallos (nunca agregar `|| true`). El contrato de red es `bandait-protocol/CONTRACT_V3.md`.
- PySide6 Leader: `cd bandait-leader && ruff check src tests && QT_QPA_PLATFORM=offscreen python -m pytest -q`
- React Follower: `cd bandait-follower && npm run lint && npx vitest run && npm run build` (`npm test` deja vitest en modo watch).
- Web Hub: `cd bandait-leader-web && npm run lint && npm run verify:logic && npm run build`
- E2E: `npx playwright test` desde la raíz.
- Bundles publicados (`landing/app`, `landing/hub`): regenerar con `npm run build:landing`; Cloudflare publica `landing/` tal cual desde `main`.
