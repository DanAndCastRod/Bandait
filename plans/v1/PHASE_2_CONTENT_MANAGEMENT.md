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
- [x] **LRC Parser:**
    - **Componente Stitch:** Ver `synchronized_lrc_editor_1` y `_2`.
    - Implementar parser de Regex para formato estándar LRC `[mm:ss.xx] Texto`.
    - Extender formato para soportar metadatos (BPM, Compás) en cabeceras custom tags `#BPM:120`.
- [x] **Persistencia Local:**
    - Implementar base de datos local (Hive o Drift) para guardar el repertorio en el dispositivo.
    - Cachear canciones recibidas del Líder para no re-descargar si no han cambiado (hash check).
- [x] **Gestor de Setlists:**
    - **Componente Stitch:** Ver `song_library_manager`.
    - CRUD básico de Listas de Reproducción.
    - Reordenamiento UI (ReorderableListView).

### Sprint 6: Motor de Visualización (Lyrics Engine)
**Objetivo:** Visualizar la letra correcta en el momento exacto.

#### Tareas
- [x] **Visualizador de Texto Sincronizado:**
    - Widget que recibe `currentSongTime` y resalta la línea activa.
    - Auto-scroll suave: Implementado en `LyricEditorPage`.
- [x] **Interpolación de Tiempo:**
    - Implementado con `Stopwatch` y `Timer.periodic`.
- [x] **Editor Básico (Opcional MVP):**
    - Implementado "Mark Beat" para sincronización en tiempo real.
    - Implementado "Paste Text" para carga rápida.
- [x] **Stage View (Siguiente Paso):**
    - Implementado `StageViewPage` basado en `musician_stage_view`.
    - Modo solo lectura con metrónomo visual y letra grande para el escenario.

### Sprint 7: Gestión de Setlists (Completado)
**Objetivo:** Organizar las canciones en listas para el show.

#### Tareas
- [x] **Modelo de Datos:**
    - `Setlist` con ID, Título, Fecha y lista de IDs de canciones.
    - **Componente Stitch:** `dynamic_setlist_manager`.
- [x] **UI de Librería:**
    - Listado de Setlists guardados.
    - Creación de nuevos setlists.
- [x] **UI de Editor:**
    - Agregar canciones desde la librería.
    - Reordenar (Drag & Drop).
    - Eliminar canciones.
    - Renombrar Setlist.

## 🚧 Pendientes / Siguiente Fase
1.  **CRUD Completo:** Editar Título/Artista y Borrar canciones de la librería (Pendiente menor).
2.  **Sincronización P2P:** La transferencia de canciones Líder->Follower (Fase 3).
3.  **Cloud Sync:** Backup en la nube (Fase 6).

## 🧪 Criterios de Aceptación
1.  Carga archivos .lrc estándar correctamente.
2.  El scroll de la letra es suave y anticipa la lectura.
3.  Persistencia: Al cerrar y abrir la app, las canciones siguen ahí.
