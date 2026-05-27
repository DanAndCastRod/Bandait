# BIOSCODE.md

Contexto persistente del proyecto para sesiones de Bioscode. Generado por `/init` y mantenido manualmente cuando cambien los fundamentos del repo.

## Visión general

Bandait es un sistema multiplataforma de sincronización en tiempo real para músicos en vivo. Resuelve el problema de latencia variable (jitter) al sincronizar relojes entre dispositivos via NTP custom en lugar de transmitir audio por Wi-Fi. Un dispositivo Líder orquesta la sesión; los Seguidores reciben comandos de tiempo y generan audio localmente.

## Stack

- Lenguaje principal: Dart
- Runtime/framework: Flutter (SDK ^3.10.7), multiplataforma (Android, iOS, Windows, macOS, Web)
- Build / package manager: `flutter` CLI + `pubspec.yaml`
- State management: BLoC (`flutter_bloc`)
- Dependency Injection: `get_it` + `injectable` (generado con `build_runner`)
- Audio: `flutter_soloud`
- Persistencia local: `hive` + `hive_flutter`
- Descubrimiento de red: `nsd` (mDNS) + `qr_flutter` / `mobile_scanner`
- Code generation: `freezed`, `json_serializable`, `injectable_generator`, `hive_generator`
- Testing: `flutter_test`, `mocktail`, `mockito`
- Linting / formato: `flutter_lints` (configurado en `analysis_options.yaml`)

## Estructura del repo

- `lib/` — Código fuente principal (Dart)
  - `application/` — Coordinadores de alto nivel (ej. `distributed_metronome_manager.dart`)
  - `core/di/` — Configuración de Dependency Injection (`get_it` + `injectable`)
  - `core/utils/` — Utilidades compartidas
  - `data/datasources/` — Implementaciones de WebSocket server/client
  - `data/network/` — Servicios de red (`socket_service.dart`, `clock_service.dart`)
  - `data/repositories/` — Implementaciones de repositorios
  - `data/services/` — Implementaciones de motores (audio, metrónomo, sync, parser LRC)
  - `domain/entities/` — Entidades puras
  - `domain/enums/` — Enumeraciones (`message_type.dart`, `connection_status.dart`)
  - `domain/models/` — Modelos inmutables con `freezed` + `hive` adapters
  - `domain/repositories/` — Contratos/abstract classes de repositorios y motores
  - `presentation/bloc/` — Estados y eventos BLoC (con archivos `.freezed.dart` generados)
  - `presentation/pages/` — Pantallas organizadas por feature (`library/`, `connect/`, `stage/`, etc.)
  - `presentation/theme/` — `AppTheme` con tema oscuro personalizado
  - `presentation/widgets/` — Widgets reutilizables (`visual_metronome.dart`, `panic_overlay.dart`, etc.)
- `test/` — Tests unitarios y de widget (`flutter_test`, `mocktail`, `mockito`)
- `android/`, `ios/`, `windows/`, `macos/`, `linux/`, `web/` — Configuraciones nativas por plataforma
- `landing/` — Landing page estática (HTML/CSS/JS)
- `plans/` — Planes de desarrollo por fase (v1/ y stitch_leader_session_lobby/)
- `docs/` — Documentación adicional (`DEPLOY.md`)
- `.github/workflows/` — CI/CD (`ci.yml`, `release-builds.yml`)

## Patrones de arquitectura

- **Clean Architecture**: separación clara en `domain/` (contratos + modelos), `data/` (implementaciones + fuentes de datos), `presentation/` (UI + BLoC), `application/` (coordinadores).
- **Repository Pattern**: interfaces en `domain/repositories/`, implementaciones en `data/repositories/`.
- **BLoC (Business Logic Component)**: estado manejado via `flutter_bloc` en `presentation/bloc/`. Estados y eventos generados con `freezed`.
- **Dependency Injection**: configuración centralizada en `core/di/injection.dart` usando `get_it` + `injectable`. Se genera `injection.config.dart` via `build_runner`.
- **Modelos inmutables**: todas las entidades de dominio usan `freezed` + `json_serializable` para serialización, y `hive` para persistencia local (con `HiveType`/`HiveField`).
- **WebSockets custom**: comunicación directa via sockets TCP (no Socket.io observado en código actual), con servicio de reloj NTP custom en `data/network/clock_service.dart`.

## Convenciones de código

- **Naming**: clases en PascalCase, archivos en snake_case. Archivos generados por build_runner llevan sufijos `.freezed.dart` y `.g.dart`.
- **Imports**: se usa `package:bandait/...` para imports internos.
- **Theme**: tema oscuro forzado (`Brightness.dark`), fondo `#000000` (`darkBackground`), color primario actual `#ff6600` (Stitch Orange) en `AppTheme.primaryColor`. Tipografía principal: `GoogleFonts.spaceGrotesk`.
- **Manejo de errores**: try/catch en inicialización de motores (ej. `AudioEngine`), mensajes via `debugPrint` o `ScaffoldMessenger` para feedback visual.
- **Tests**: mocks con `mocktail` (y `mockito` en algunos casos), registro manual en `GetIt` para inyección de mocks, `tearDown` con `getIt.reset()`.

## Scripts y comandos

- `flutter pub get` — instalar dependencias
- `dart run build_runner build --delete-conflicting-outputs` — regenerar código (freezed, injectable, hive, json_serializable)
- `flutter run` — ejecutar en modo desarrollo
- `flutter test` — ejecutar tests
- `flutter build apk --release` — build Android APK
- `flutter build windows --release` — build Windows x64
- `flutter analyze` — linting via analyzer

## Notas operativas

- **Code generation obligatorio**: después de modificar modelos `@freezed`, entidades `@HiveType`, o clases `@injectable`, ejecutar `build_runner` para regenerar archivos `.freezed.dart`, `.g.dart` e `injection.config.dart`.
- **Puerto por defecto**: el servidor WebSocket usa puerto `4040` (hardcodeado en `main.dart`).
- **Persistencia local**: Hive se inicializa en `main()` con `Hive.initFlutter()` y se registran adapters para `Song`, `LyricLine` y `UserProfile`.
- **Punto de entrada de la app**: `ProfileSelectionPage` (desde `main.dart`), no `RoleSelectionPage` (clase legacy en el mismo archivo).
- **Landing page**: despliegue manual a GitHub Pages; la landing está en `landing/` (HTML/CSS/JS plano).
- **Documentación de diseño**: ver `guia_diseño.md` para el sistema OLED Noir & Neon (aunque el tema actual usa Stitch Orange como primario).
- **Contexto extendido**: ver `CONTEXT.md` para estructuras de datos JSON de sesión y canciones, y `README.md` para instrucciones de deploy.
- **Principios de diseño de agentes** (de `CLAUDE.md` y `GEMINI.md`):
  - **Robustness First**: asumir que la red fallará; diseñar para la desconexión.
  - **No stream audio**: se envían *instrucciones de tiempo*, no ondas de sonido.
  - **Dark by Default**: interfaces OLED negras (`#000000`).
  - **Latency Obsessed**: cuestionar el costo de cada llamada de red o async en el hot path.
  - **Audio**: no usar streaming de mp3 para el metrónomo; usar síntesis de onda.
  - **Red**: asumir conexiones UDP/TCP inestables; implementar reconexión agresiva.
  - **UI**: evitar animaciones complejas que consuman CPU en modo "Live".
  - **Regla de Oro UX**: un botón grande y feo que funciona es mejor que un menú hamburguesa elegante que requiere precisión. Los músicos tienen las manos ocupadas, están nerviosos y la iluminación es mala.
