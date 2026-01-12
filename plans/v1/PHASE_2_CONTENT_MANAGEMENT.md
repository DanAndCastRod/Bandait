# Fase 2: Contenido y Gestión

**Objetivo Crítico:** Permitir la gestión y visualización de estructuras musicales complejas (Canciones, Letras, Secciones).

## 🧠 Modelado de Datos
Necesitamos un formato estándar y eficiente. Usaremos JSON para transporte y objetos Dart tipados para runtime.

### Modelo de Canción (.LRC extendido)
```json
{
  "id": "uuid",
  "title": "Cancion Prueba",
  "bpm": 120,
  "signature": "4/4",
  "duration_ms": 180000,
  "lyrics": [
    { "time_ms": 1500, "text": "Primera linea", "type": "verse" },
    { "time_ms": 4000, "text": "[Coro]", "type": "section_header" }
  ]
}
```

---

## 📅 Desglose de Sprints

### Sprint 5: Parsing y Persistencia
**Objetivo:** Cargar, guardar y entender archivos de canciones.

#### Tareas
- [ ] **LRC Parser:**
    - Implementar parser de Regex para formato estándar LRC `[mm:ss.xx] Texto`.
    - Extender formato para soportar metadatos (BPM, Compás) en cabeceras custom tags `#BPM:120`.
- [ ] **Persistencia Local:**
    - Implementar base de datos local (Hive o Drift) para guardar el repertorio en el dispositivo.
    - Cachear canciones recibidas del Líder para no re-descargar si no han cambiado (hash check).
- [ ] **Gestor de Setlists:**
    - CRUD básico de Listas de Reproducción.
    - Reordenamiento UI (ReorderableListView).

### Sprint 6: Motor de Visualización (Lyrics Engine)
**Objetivo:** Visualizar la letra correcta en el momento exacto.

#### Tareas
- [ ] **Visualizador de Texto Sincronizado:**
    - Widget que recibe `currentSongTime` y resalta la línea activa.
    - Auto-scroll suave: La línea activa siempre debe estar centrada verticalmente o en el tercio superior.
- [ ] **Interpolación de Tiempo:**
    - El UI update rate (60fps) debe consultar el reloj sincronizado y actualizar la posición del scroll suavemente, no "a saltos" por línea.
- [ ] **Editor Básico (Opcional MVP):**
    - Permitir ajustar el offset de la letra (+/- ms) en tiempo real si el lrc está mal sincronizado.

## 🧪 Criterios de Aceptación
1.  Carga archivos .lrc estándar correctamente.
2.  El scroll de la letra es suave y anticipa la lectura.
3.  Persistencia: Al cerrar y abrir la app, las canciones siguen ahí.
