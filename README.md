# Bandait

**Sistema de sincronización en tiempo real para músicos en vivo.**

> "Sincronización de Relojes, no de Audio" — Los dispositivos acuerdan qué hora es (NTP) y ejecutan comandos en el futuro.

🔗 **Website:** [bandait.releven.cc](https://bandait.releven.cc)

---

## 🎯 ¿Qué es?

Bandait elimina el caos en el escenario manteniendo a toda la banda alineada mediante tecnología de ultra-baja latencia. Un dispositivo **Líder** orquesta la sesión; los **Seguidores** reciben comandos de tiempo y generan audio localmente.

**Características principales:**
- ⚡ Sync de relojes NTP (cero latencia percibida)
- 📋 Setlist con BPM, estructura y letras sincronizadas
- 🔲 Metrónomo visual periférico (borde de pantalla)
- 📱 Multiplataforma: Android, Windows, iOS, macOS

---

## 🏗️ Tech Stack

| Componente | Tecnología |
|---|---|
| Framework | Flutter (Dart) |
| Comunicación | WebSockets + NTP Custom |
| Audio | flutter_soloud |
| Estado | BLoC (flutter_bloc) |
| Descubrimiento | mDNS + QR |

---

## 📂 Estructura del Proyecto

```
Bandait/
├── lib/                    # Código fuente principal (Dart)
├── landing/                # Landing page estática (HTML/CSS/JS)
├── android/                # Configuración Android
├── ios/                    # Configuración iOS
├── windows/                # Configuración Windows
├── web/                    # Flutter Web (bootstrap)
├── plans/                  # Planes de desarrollo por fase
├── docs/
│   └── DEPLOY.md           # Guía de despliegue
├── .github/workflows/      # CI/CD pipelines
├── guia_diseño.md          # Sistema de diseño UI
├── CONTEXT.md              # Contexto técnico del proyecto
└── pubspec.yaml            # Dependencias Flutter
```

---

## 🚀 Desarrollo Local

```bash
# Instalar dependencias
flutter pub get

# Generar código (injectable, freezed, etc.)
dart run build_runner build --delete-conflicting-outputs

# Ejecutar en modo desarrollo
flutter run

# Ejecutar tests
flutter test
```

### Build de producción

```bash
# Android APK
flutter build apk --release

# Windows x64
flutter build windows --release
```

---

## 📦 Despliegue

- **Landing Page:** Se despliega automáticamente a GitHub Pages via `.github/workflows/deploy-landing.yml`
- **Builds (APK + Windows):** Se generan con cada tag `v*` via `.github/workflows/release-builds.yml`
- **Play Store:** AAB via `.github/workflows/release-android.yml`
- **TestFlight:** IPA via `.github/workflows/release-ios.yml`

📖 Ver [docs/DEPLOY.md](docs/DEPLOY.md) para la guía completa.

---

## 📚 Documentación

- [CONTEXT.md](CONTEXT.md) — Visión, arquitectura y datos clave
- [guia_diseño.md](guia_diseño.md) — Sistema de diseño OLED Noir & Neon
- [docs/DEPLOY.md](docs/DEPLOY.md) — Guía de despliegue
- [plans/](plans/) — Planes de desarrollo por fase

---

## 🎨 Diseño

Estética **OLED Noir & Neon**: fondo `#000000`, alto contraste, tipografía Inter + JetBrains Mono, acentos neón (Cyan `#00FFFF`, Lime `#CCFF00`, Magenta `#FF00FF`).

Diseñado para escenarios oscuros con luces estroboscópicas. Botones masivos, carga cognitiva cero.

---

*by [Releven](https://releven.cc)*
