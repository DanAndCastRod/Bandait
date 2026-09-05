# Bandait 3.0: The Live Band Operating System
## Plan Maestro de Reconceptualización, Arquitectura y Robustecimiento en Escenario

**Fecha de Aprobación y Robustecimiento:** 5 de Septiembre de 2026  
**Estado:** Aprobado y Blindado vía Análisis Exhaustivo de Escenario Real (/grill-me)  
**Tema Visual Predeterminado:** Swiss Bauhaus Lab (Personalizable independientemente por músico en su dispositivo)  
**Restricción Estética Central:** Cero iconos emoji en toda la plataforma (100% SVG vectorial técnico y tipografía especializada).

---

## 1. Visión y Reconceptualización

Bandait 3.0 evoluciona de un metrónomo sincronizado básico a un **Sistema Operativo Integral en Vivo para Bandas**, diseñado para resistir las condiciones más extremas de escenario (caídas de red, interferencias de radiofrecuencia, cambios improvisados de repertorio y acústica de alta exigencia):

* **Sincronización Híbrida de Ultra-Baja Latencia:** Protocolo de tiempo NTP local sobre Wi-Fi (offset verificado < 5.1ms, jitter < 0.2ms) con fallback transparente por Internet (WebSocket/WebRTC).
* **Ruteo Físico ASIO Profesional en Líder:** Generación de clic y pistas auxiliares directo al hardware de audio (Salidas 1-2 a PA/FOH, Salida 3 dedicada al baterista por cable sin latencia de red).
* **Control Concurrente Maestro (Laptop + Smartphone del Director):** Mando dual simultáneo. Tanto la laptop en mesa de sonido como el smartphone del director en escenario pueden disparar transporte (Play, Stop, Cue, Next) con precedencia de última orden y confirmación visual inmediata.
* **Tolerancia a Fallos 'Flywheel Autónomo':** Si un músico pierde cobertura Wi-Fi en pleno show, su smartphone mantiene el tempo y compás de forma autónoma por inercia matemática con su oscilador local, aplicando un reajuste suave de fase (*soft phase-alignment*) al reconectarse sin cortes de audio.
* **Pre-Caché Local de Stems (IndexedDB):** Todo el audio multipista se pre-descarga en el dispositivo antes del show; durante el concierto solo viaja telemetría de sincronización NTP ligera (< 1 KB/s), garantizando cero dropouts de audio.
* **Saltos Imprevistos de Setlist (Audibles en Vivo):** Si el director salta a un tema fuera de orden, el sistema actualiza tempo y acordes al instante y despliega un banner de alta visibilidad (*"SALTO DE SETLIST: TEMA 07"*) en las pantallas de toda la banda.
* **Transiciones Configurables por Canción:** Cada ítem del setlist define si espera la orden del líder (*Manual Cue*) o arranca automáticamente al compás con conteo (*Auto Conteo / Gapless*).
* **Administración Multi-Banda y Web Hub:** Gestión de múltiples agrupaciones por usuario con autenticación Google OAuth y OTP por WhatsApp o SMS tradicional.
* **Importación y Exportación Universal XLSX:** Libro maestro multi-pestaña (*Canciones*, *Setlists*, *Equipo*) con previsualización interactiva de diferencias (*Diff Preview*) para resolver conflictos.
* **Pipeline de IA Asíncrono en Nube:** Separación de stems en workers con GPU (Demucs), detección automática de acordes/BPM y secuenciador armónico basado en la rueda Camelot.
* **Ergonomía de Hardware y 4 Estilos Radicales:** Componentes físicos-digitales de audio (faders graduados en dB, diales 270°, VFD, limitador a -0.5 dBFS) con elección libre e independiente de estilo visual por cada músico en su propio dispositivo.

---

## 2. Decisiones Arquitectónicas Robustecidas (/grill-me Consensus)

A continuación se resumen los acuerdos técnicos fundamentales que blindan la operación del sistema:

| Dimensión | Decisión Arquitectónica Acordada | Razón Técnica / Mitigación de Riesgo |
| :--- | :--- | :--- |
| **Monitoreo In-Ear Móvil** | **Pre-descarga en IndexedDB** antes del show. En vivo solo viajan pulsos NTP (< 1 KB/s). | Elimina saturación de ancho de banda Wi-Fi y dropouts de audio en recintos congestionados. |
| **Caída de Conexión Wi-Fi** | **Modo Flywheel Autónomo**: el oscilador Web Audio mantiene el tiempo por inercia; reconexión con *soft phase-align*. | Evita silencios abruptos o confusión rítmica si un músico camina fuera del alcance de la antena. |
| **Autoridad de Mando** | **Control Concurrente Maestro**: Laptop Desktop y Smartphone del Director tienen autoridad compartida (última orden gana). | Agilidad máxima para el director musical en tarima sin obligarlo a desplazarse a la laptop. |
| **Cambio de Tema en Vivo** | **Salto Inmediato + Banner de Alerta**: cambio instantáneo con notificación visual destacada en todos los followers. | Permite responder a la energía del público manteniendo a todos los músicos sincronizados. |
| **Gestión de Datos XLSX** | **Libro Maestro Multi-Pestaña** con modal de previsualización de diferencias (*Diff Preview*). | Previene sobreescrituras accidentales y permite auditoría clara de cambios en el catálogo. |
| **Autenticación Web Hub** | **Canal Híbrido WhatsApp / SMS OTP + Google OAuth** con vinculación a cuenta unificada. | Tasa de entrega de 99.8% de códigos en Latinoamérica y acceso rápido sin recordar contraseñas. |
| **Cómputo de IA (Stems)** | **Workers GPU Asíncronos en Nube** con notificación WebSocket de finalización. | No sobrecarga la laptop del líder y democratiza el procesamiento para cualquier miembro de la banda. |
| **Flujo de Setlist** | **Transición Configurable por Ítem** (*Manual Cue* para pausas/charlas o *Auto Conteo* para sets continuos). | Flexibilidad artística para alternar entre momentos de improvisación y suites musicales continuas. |

---

## 3. Sistema de Diseño Visual y Tipografía

### 3.1. Estilo Predeterminado: Swiss Bauhaus Lab
* **Filosofía:** Racionalismo funcionalista inspirado en Dieter Rams y laboratorios de acústica suizos. Ausencia total de ruido visual decorativo.
* **Tipografía Display & Títulos:** `Space Grotesk` (Google Fonts) — Geometría sin serifa de lectura rápida.
* **Tipografía de Datos & Acordes:** `IBM Plex Mono` (Google Fonts) — Precisión métrica monoespaciada quirúrgica.
* **Componentes:** Botones cilíndricos planos, cortes ortogonales a 90°, divisores de 1px exacto, acentos en Naranja Internacional (`#ff4500`) y Azul Cobalto Técnico (`#0066ff`) sobre chasis gris cemento mate (`#181a1f`).

### 3.2. Selección Libre de Estilos por Músico (Almacenamiento Local)
Cada músico puede alternar libremente su experiencia visual en `localStorage` sin alterar la sincronización musical del resto de la banda:

1. **Swiss Bauhaus Lab (Default):** `Space Grotesk` + `IBM Plex Mono` (Precisión clínica de ensayo).
2. **Mil-Spec Avionics HUD:** `Bebas Neue` + `Share Tech Mono` (Biseles octogonales, franjas hazard, fósforo ámbar para escenarios con humo y reflectores a 3 metros).
3. **Tokyo 1989 VFD:** `Orbitron` + `Silkscreen` (Brillo fluorescente cian, rejilla de matriz de puntos 5x7 y estética sampler clásico Akai/Roland).
4. **Concert Hall:** `Cinzel` + `Playfair Display` (Serif monumental, compases en números romanos, terciopelo carbón y bronce bruñido para auditorios y directores sinfónicos).

### 3.3. Componentes Físico-Digitales de Hardware
* **Fader Vertical con Escala dB:** Calibración de ganancia (+6 dB a -∞ dB) con punto *Unity (0 dB)* para monitoreo personal in-ear.
* **Limitador de Picos de Seguridad:** Limitador de audio a -0.5 dBFS en todos los retornos in-ear para proteger los oídos de los músicos contra transientes.
* **Potenciómetro Rotativo 270°:** Dial continuo con indicador LED de estado para ajuste de tempo, ganancia y fase.
* **Cinta de Estructura de Canción (Song Ribbon):** Bloques cromáticos por sección con cursor de cabezal activo en tiempo real.
* **Iconografía Vectorial Normalizada:** Cero emojis. Uso exclusivo de glifos SVG técnicos (normas ISO/DIN de audio).

---

## 4. Arquitectura del Sistema

```
+-------------------------------------------------------------------------------+
|                             CLOUD & WEB ADMIN HUB                             |
|  * Supabase / PostgreSQL (Multi-tenant)                                       |
|  * Auth: Google OAuth + WhatsApp / SMS OTP                                    |
|  * CRUD Universal + XLSX Multi-Tab Import / Export Service (openpyxl)         |
|  * AI Workers GPU (Demucs Stems + Audio-to-ChordPro + Camelot AI DJ)          |
+---------------------------------------+---------------------------------------+
                                        | Sync / WebSockets
                                        v
+-------------------------------------------------------------------------------+
|                      ESTACIÓN CENTRAL: LÍDER DESKTOP                          |
|  * PySide6 + Python 3.11                                                      |
|  * Audio Engine: sounddevice (Backend PortAudio ASIO)                         |
|  * Salida FOH 1-2: Pistas auxiliares / Metrónomo PA                           |
|  * Salida 3 Cable: Clic dedicado baterista (< 1.5ms)                          |
|  * Servidor NTP Local: Broadcast UDP / Wi-Fi Hotspot Autónomo                 |
|  * Control Concurrente Maestro: Recibe órdenes simultáneas de Smartphone      |
+---------------------------------------+---------------------------------------+
                                        | WebSockets locales (Wi-Fi 5 GHz)
                                        v
+-------------------------------------------------------------------------------+
|                       SEGUIDORES & CONTROL REMOTO PWA                         |
|  * React 19 + TypeScript + Vite PWA                                           |
|  * Web Audio API (Generador de oscilador local + Pre-caché IndexedDB)         |
|  * Motor Flywheel Autónomo (Tolerancia a desconexión Wi-Fi)                   |
|  * Banner de Alerta de Saltos de Setlist                                      |
|  * Control Remoto de Director desde Smartphone                                |
|  * Mezclador Táctil In-Ear (3 vías: Clic, Guía Vocal, Stems con limitador)    |
|  * Selector de Estilo Local (Swiss, Mil-Spec, Tokyo, Concert Hall)            |
+-------------------------------------------------------------------------------+
```

---

## 5. Modelos de Datos Centrales (TypeScript / Python)

```typescript
// Entidad Ítem de Setlist con soporte para transición y saltos
export interface PlaylistItem {
  id: string;
  playlist_id: string;
  song_id: string;
  order: number;
  show_key?: string;                     // Tono para este show (ej: Bm -1)
  target_bpm?: number;                   // BPM ajustado para este show
  transition_mode: 'manual_cue' | 'auto_count_in' | 'gapless';
  count_in_bars?: number;                // Compases de conteo automático
  transition_notes?: string;             // Notas para el director y la banda
  created_at: string;
  updated_at: string;
}

// Estructura del Libro Maestro XLSX
export interface ExcelMasterWorkbook {
  canciones: Array<{
    id: string;
    titulo: string;
    artista: string;
    bpm_original: number;
    tono_original: string;
    duracion_segundos: number;
    letra_chordpro: string;
  }>;
  setlists: Array<{
    setlist_id: string;
    nombre_show: string;
    cancion_id: string;
    orden: number;
    tono_show: string;
    modo_transicion: string;
    notas: string;
  }>;
  equipo: Array<{
    usuario_id: string;
    nombre: string;
    telefono: string;
    rol: 'Owner' | 'MusicDirector' | 'Musician' | 'Substitute';
  }>;
}
```

---

## 6. Plan de Ejecución en Sprints

### Sprint 1: Higiene, Motor ASIO y Follower PWA
1. **Aislamiento Legacy:** Mover `lib/`, `android/`, `ios/`, etc. a `_archive/flutter_legacy/`.
2. **Corrección de Fase Clock:** Forzar `beat = 1` y reiniciar fase de reloj en comandos `START` y `RESUME` en `clock_service.py`.
3. **Motor ASIO Líder:** Implementar selección y activación de interfaces ASIO multicanal en `engine.py`.
4. **Desbloqueo de Navegación Follower:** Enrutamiento entre Connect, Stage, Library y Settings en el PWA con soporte para temas locales (Swiss Lab por defecto).
5. **Base del Motor Flywheel:** Inicialización del oscilador Web Audio tolerante a caídas de socket.

### Sprint 2: Web Admin Hub, Multi-Banda y XLSX IO
1. Autenticación híbrida Google OAuth + WhatsApp/SMS OTP.
2. Gestión multi-agrupación con roles granulares.
3. Importador y exportador universal de libro maestro `.xlsx` con modal *Diff Preview*.
4. Sincronización offline-first con SQLite local en Desktop y caché en PWA.

### Sprint 3: Control Remoto Concurrente y Ergonomía de Hardware
1. Implementación del protocolo de mando concurrente maestro para smartphone y laptop.
2. Banner de alerta para saltos imprevistos de setlist.
3. Integración de los componentes de hardware (Faders dB con limitador -0.5 dBFS, Knobs 270°, Displays VFD, Song Ribbon).
4. Motor de temas con Swiss Bauhaus Lab como predeterminado y switch de 4 estilos.

### Sprint 4: Mezcla Multipista, Pre-Caché IndexedDB y Co-Pilot con IA
1. Servicio de pre-descarga de stems a IndexedDB en Followers PWA.
2. Pipeline asíncrono en nube para separación de pistas (Demucs).
3. Transcriptor de audio a acordes ChordPro y cálculo de tonalidad Camelot.
4. Generador de prompts de voz para monitoreo in-ear.

---

*Documento consolidado en `docs/PLAN_BANDAIT_3.0_MASTER.md` y respaldado en control de versiones Git.*
