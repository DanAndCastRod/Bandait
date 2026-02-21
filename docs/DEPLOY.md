# 🚀 Guía de Despliegue — Bandait

Esta guía cubre el despliegue de la landing page y la generación de builds descargables.

---

## 1. Landing Page (`bandait.releven.cc`)

### Infraestructura
La landing page es HTML/CSS/JS estático servido desde **GitHub Pages**.

| Item | Valor |
|------|-------|
| **Directorio fuente** | `landing/` |
| **Workflow** | `.github/workflows/deploy-landing.yml` |
| **Trigger** | Push a `main` que modifique `landing/**` |
| **Custom domain** | `bandait.releven.cc` (via `landing/CNAME`) |

### Configuración Inicial (una sola vez)

#### 1.1 Configurar GitHub Pages
1. Ve a **Settings → Pages** en el repo de GitHub.
2. En **Source**, selecciona **GitHub Actions**.
3. No necesitas seleccionar branch; el workflow se encarga de todo.

#### 1.2 Configurar DNS
Agrega un registro **CNAME** en tu proveedor de DNS:

```
bandait.releven.cc → DanAndCastRod.github.io
```

> **Nota:** Si tu organización/usuario en GitHub es diferente, ajusta el target del CNAME.

#### 1.3 Verificar Dominio (Opcional, recomendado)
En GitHub: **Settings → Pages → Custom Domain**, ingresa `bandait.releven.cc` y sigue las instrucciones de verificación.

### Deploy Manual
```bash
# El deploy es automático con push a main, pero si necesitas forzarlo:
# Ve a Actions → Deploy Landing Page → Run workflow
```

---

## 2. Builds de Release (Android APK + Windows)

### Infraestructura

| Item | Valor |
|------|-------|
| **Workflow** | `.github/workflows/release-builds.yml` |
| **Trigger** | Push de tag `v*` (ej: `v1.0.0`) |
| **Artefactos** | `app-release.apk`, `bandait-windows-x64.zip` |
| **Destino** | Assets del GitHub Release correspondiente al tag |

### Proceso de Release

```bash
# 1. Actualiza la versión en pubspec.yaml
# version: 1.0.1+2

# 2. Commit
git add -A
git commit -m "chore: bump version to 1.0.1"

# 3. Crear tag y push
git tag v1.0.1
git push origin main --tags
```

El workflow automáticamente:
1. Crea un GitHub Release para el tag
2. Compila el APK de Android (universal, firmado)
3. Compila el ejecutable de Windows (x64)
4. Adjunta ambos archivos al Release

### Secrets Requeridos

Configura estos en **Settings → Secrets and variables → Actions**:

| Secret | Descripción |
|--------|-------------|
| `ANDROID_KEYSTORE_BASE64` | Keystore JKS codificado en base64 |
| `ANDROID_KEYSTORE_PASSWORD` | Contraseña del keystore |
| `ANDROID_KEY_PASSWORD` | Contraseña de la key |
| `ANDROID_KEY_ALIAS` | Alias de la key (ej: `upload`) |

> Los secrets de Android son los mismos que usa `release-android.yml` para publicar en Play Store.

#### Generar el Keystore en Base64
```bash
base64 -i upload-keystore.jks | tr -d '\n' > keystore_base64.txt
# Copia el contenido de keystore_base64.txt al secret ANDROID_KEYSTORE_BASE64
```

### Build Local (sin CI)

```bash
# Android APK
flutter build apk --release

# Windows
flutter build windows --release
# El ejecutable estará en: build/windows/x64/runner/Release/
```

---

## 3. Estructura de Workflows

```
.github/workflows/
├── ci.yml                 # PR: analyze + test
├── deploy-landing.yml     # Push main → GitHub Pages
├── release-android.yml    # Tag v* → Play Store (AAB)
├── release-builds.yml     # Tag v* → GitHub Release (APK + Windows ZIP)
└── release-ios.yml        # Tag v* → TestFlight (IPA)
```

---

## 4. Troubleshooting

### La landing no se actualiza
1. Verifica que el push modificó archivos en `landing/`.
2. Revisa la pestaña **Actions** para ver si el workflow se ejecutó.
3. Fuerza un redeploy con **Run workflow** manual.

### Los builds fallan por signing
1. Verifica que los secrets están configurados correctamente.
2. El build de Windows **no requiere signing**, así que debería funcionar sin secrets.
3. Solo el build de Android requiere el keystore.

### Custom domain no funciona
1. Verifica el registro CNAME en tu DNS (puede tardar hasta 48h en propagar).
2. Asegúrate de que `landing/CNAME` contiene exactamente `bandait.releven.cc`.
3. En GitHub Pages settings, verifica que el dominio aparece como verificado.
