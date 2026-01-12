# Guía de Diseño: Bandait (Stage-Ready UI System)

Esta guía define el sistema de diseño visual y de interacción para **Bandait**.
**Mantra:** "Lo que no suma, resta. En el escenario, menos es más."

---

## 1. Filosofía de Diseño: "OLED Noir & Neon"

El entorno de uso es hostil: escenarios oscuros, luces estroboscópicas, humo, sudor y adrenalina. La interfaz no busca ser "bonita" en el sentido tradicional; busca ser **indestructible** y **absolutamente legible**.

### Principios Core
1.  **Oscuridad Absoluta (True Black):** El fondo siempre es `#000000`. No gris oscuro. Negro. Esto apaga los píxeles en pantallas OLED, ahorra batería crítica y evita que el dispositivo se convierta en una linterna que ilumina la cara del músico desde abajo.
2.  **Contraste Extremo:** La información crítica "salta" a la vista. Textos blancos o neón sobre negro.
3.  **Toque Seguro (Fat Finger):** Los botones son masivos. Los márgenes de error son amplios.
4.  **Carga Cognitiva Cero:** Solo muestra lo que importa *ahora*.
5.  **Estética Moderna y Minimalista:** Se busca una apariencia visual vigente, limpia y minimalista, que transmita tecnología de punta sin sacrificar funcionalidad.

---

## 2. Paleta de Colores

### Bases
| Color | Hex | Uso |
| :--- | :--- | :--- |
| **Stage Black** | `#000000` | Fondo global. Sin excepciones en Stage Mode. |
| **Off White** | `#F0F0F0` | Texto principal, Letras de canciones. |
| **Disabled Grey** | `#333333` | Elementos inactivos o líneas futuras (letras). |

### Acentos (Neon High-Vis)
Usados para feedback de estado y elementos interactivos activos.

| Nombre | Hex | Uso |
| :--- | :--- | :--- |
| **Electric Cyan** | `#00FFFF` | Enlace, Conexión, Elementos de UI activos. |
| **Acid Lime** | `#CCFF00` | Éxito, "Play", "Listo". |
| **Plasma Magenta** | `#FF00FF` | Acento secundario, beat fuerte, usuario seleccionado. |
| **Alert Orange** | `#FF4400` | Advertencias, Jitter medio. |
| **Critical Red** | `#FF0000` | Error fatal, Desconexión, "Stop". |

---

## 3. Tipografía

Priorizamos legibilidad y estabilidad numérica (Monospaced).

### Familia Principal: `Inter` o `Roboto` (Sans Serif)
Para textos generales, menús y, sobre todo, **Letras**.
- **Pesos:** Bold (Títulos), Medium (Cuerpo), Regular (Secundario). No usar Light ni Thin.

### Familia Numérica: `JetBrains Mono` o `Roboto Mono`
Para Timecodes, BPM, Acordes y Datos Técnicos.
- **Razón:** Los números monoespaciados no saltan horizontalmente cuando cambian (ej. de "11" a "00"). Mantiene la UI estable.

### Jerarquía de Tamaños (Mobile)
- **Huge (BPM / Beat):** 64sp - 96sp
- **Title (Canción Actual):** 32sp - 40sp
- **Lyrics (Active):** 24sp - 32sp (Alto contraste)
- **Lyrics (Next):** 18sp - 20sp (Opacidad 50%)
- **Body / Metadata:** 16sp

---

## 4. Componentes de UI (Stage Kit)

### Botones de Acción (Action Pads)
No usamos botones estándar de Material/Cupertino. Usamos "Pads" estilo controlador MIDI.
- **Forma:** Rectangular con bordes levemente redondeados (4px).
- **Estado Normal:** Borde de 2px (Color Acento), Fondo Transparente/Negro.
- **Estado Presionado:** Fondo Relleno (Color Acento), Texto Negro.
- **Feedback:** Flash visual inmediato al tocar.

### The Beacon (Indicador de Estado)
Un elemento de UI omnipresente (usualmente una barra superior o un borde de pantalla) que indica salud de red.
- **Barra Sólida Verde:** Todo OK (Ping < 20ms).
- **Parpadeo Amarillo:** Advertencia (Jitter detectado).
- **Rojo Pulsante:** ERROR CRÍTICO (Desconexión).

### Lista de Canciones (Setlist)
- **Elemento Activo:** Fondo resaltado (`#1A1A1A`), borde izquierdo de color Acento, Texto Blanco Brillante.
- **Elemento Pasivo:** Texto Gris (`#888888`), sin fondo.
- **Scroll:** Automático y suave. El elemento activo siempre busca el centro óptico.

---

## 5. Feedback e Interacción

### Visual Metronome (El Marco)
En lugar de un punto parpadeando que hay que mirar fijamente, usamos la visión periférica.
- **Borde de Pantalla (5-10px):** Parpadea con el beat.
- **Beat 1 (Fuerte):** Flash Blanco/Cyan Brillante.
- **Beats 2-4 (Débiles):** Flash Gris/Azul Tenue.

### Haptics (Vibración)
El tacto es más rápido que la vista en ciertas reacciones.
- **Play:** Vibración corta y seca ("Click").
- **Stop:** Doble vibración fuerte ("Thump-Thump").
- **Error:** Vibración larga y ruidosa.

### Gestos de Seguridad
Para evitar catástrofes:
- **Slide to Stop:** El botón de detener sesión (en el Líder) no es un click simple. Es un "Slide to Confirm" (como apagar el iPhone) para evitar paradas accidentales.
- **Long Press:** Para acciones destructivas (borrar canción, expulsar miembro).

---

## 6. Recursos Gráficos
- **Iconografía:** Material Symbols Rounded o Sharp. Rellenos (Filled) para mejor visibilidad.
- **Logo:** Estilo Industrial/Stencil.

---

## 7. Accesibilidad en Escenario
- **No Red-Green dependence:** No confiar solo en verde/rojo para el estado (daltónicos). Usar también formas o parpadeo vs fijo.
- **Brillo:** La app debe poder forzar el brillo de pantalla al máximo (opcional) o adaptarse.
