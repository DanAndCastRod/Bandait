# Bugs conocidos

Ultima revision: 2026-09-30 (rama `fix/stage-wiring-hygiene`). Contrato de red: `bandait-protocol/CONTRACT_V3.md`.

## Reportados originalmente

| # | Reporte original | Estado | Evidencia |
|---|---|---|---|
| 1 | "Solo puedo moverme entre BANDAIT IDENTITY, HOST SESSION y JOIN SESSION, no importa si soy leader o follower" | Obsoleto | Eran pantallas de la app Flutter, archivada en `_archive/flutter_legacy/`. El follower 3.0 navega entre Connect, Stage, Library y Settings sin cortar la sesion (`bandait-follower/src/services/sessionController.ts`). |
| 2 | "Al dar start el metronomo no suena, solo parpadea en el follower; el leader no sabe si esta ejecutando; cada start debe iniciar en el pulso 1" | Corregido, sin probar en telefonos reales | El leader arranca su servidor y emite `state_update`/`beat_beacon`; el follower programa los clics en Web Audio desde `anchor_ns` (boton ACTIVAR AUDIO para iOS). PLAY y RESUME empiezan en beat 1 por contrato. Prueba cruzada contra el leader headless: error de fase 0.0000 ms. |
| 3 | "No es posible navegar por el resto de la aplicacion" | Corregido | Igual que el 1, en la app 3.0. |

## Abiertos

1. **Resuelto por diseno: el PWA publicado en HTTPS no puede conectar a un leader en la LAN.** Una pagina HTTPS no abre `ws://` hacia la LAN (Chrome 154 lo marca como Mixed Content; verificado el 2026-09-30). Decision del usuario (opcion A): en escenario, el leader sirve el follower por HTTP en `http://<ip-lan>:4040/`, con QR para la camara nativa; el sitio HTTPS redirige alli. Verificado en Chrome de escritorio entrando por la IP Wi-Fi: carga desde el leader, auto-union como director, PLAY y compas avanzando a 120 BPM, RTT 1.7 ms.
2. Sin probar en telefonos reales: desbloqueo de audio en iOS, mantener la pantalla encendida con video en HTTP, redireccion HTTPS al leader, fuentes sin internet (se usan las de respaldo).
3. Sin probar con hardware: salida ASIO y clic de baterista en la salida 3; alineacion acustica del clic FOH contra los telefonos.
4. El callback de audio del leader es Python: riesgo residual de contencion del GIL bajo carga.
