# Fase 6: Despliegue y Distribución

**Objetivo Crítico:** Transformar el código en un producto instalable, verificable y actualizable en los dispositivos de los músicos sin fricción.

## 🚀 Estrategia de Lanzamiento
El despliegue no es el final, es el comienzo del soporte. Bandait debe ser distribuido a través de canales oficiales (Stores) para garantizar confianza y actualizaciones automáticas.

---

## 📅 Desglose de Sprints

### Sprint 13: Infraestructura de CI/CD y Compliance
**Objetivo:** Automatizar la construcción y cumplir con los requisitos legales/técnicos de las tiendas.

#### Tareas
- [ ] **Gestión de Secretos:**
    - Generar y asegurar Keystores (Android) y Certificates/Provisioning Profiles (iOS).
    - Configurar variables de entorno en CI (API Keys, Signing configs).
- [ ] **Pipeline de CI/CD (GitHub Actions / Codemagic):**
    - Workflow para PRs: `flutter analyze` + `flutter test`.
    - Workflow para Release: Build `appbundle` / `ipa` -> Upload to Store.
- [ ] **Configuración de Tiendas (Draft):**
    - **Google Play Console:** Crear app, configurar "Internal Testing".
    - **App Store Connect:** Crear app, configurar TestFlight.
- [ ] **Compliance & Legal:**
    - Redactar Política de Privacidad (enfatizar: NO recolectamos audio, solo micro para calibración si aplica).
    - Definir "Data Safety Form" (Google) y "App Privacy Details" (Apple).
    - Justificación de permisos sensibles (Red local, Micrófono, Background Audio).

### Sprint 14: Beta Testing y Public Launch
**Objetivo:** Validar con usuarios reales y liberar la versión 1.0.

#### Tareas
- [ ] **Closed Beta:**
    - Distribuir a un grupo pequeño de músicos (TestFlight / Google Play Internal).
    - Recolectar feedback de instalación y primeros usos.
- [ ] **Assets de Marketing:**
    - Screenshots de 6.5" y 12.9" (iPad Pro).
    - Icono de alta resolución (1024x1024).
    - Feature Graphic (Google Play).
    - Descripción corta y larga (SEO friendly).
- [ ] **Release Candidate (RC):**
    - Congelar código (Code Freeze).
    - Smoke Test manual final en dispositivos físicos reales.
- [ ] **Producción:**
    - Enviar a revisión (Review Process).
    - Monitoreo de "Vitals" (Crashlytics) post-lanzamiento.

## 🧪 Criterios de Aceptación
1.  Push a `main` dispara automáticamente un build que termina en TestFlight/Google Play Console.
2.  La aplicación pasa la revisión de Apple/Google sin rechazos por permisos o política.
3.  Mecanismo de "Force Update" funcionando (si hay un bug crítico en la v1.0, la v1.1 debe obligar a actualizar).
