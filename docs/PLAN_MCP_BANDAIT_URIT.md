# MCP de Bandait y MCP de URiT IA: propuesta

**Fecha:** 2026-11-20
**Estado:** propuesta para revisión de Daniel Castañeda. Nada implementado.
**Motivo:** depurar un trabajo de IA hoy exige que Daniel Castañeda repita la acción mientras un
agente escucha `wrangler tail`, y nada queda guardado. Con un MCP, un agente pregunta "por qué
falló el último trabajo" y obtiene la causa, el proveedor y el código sin reproducir nada.

---

## 1. Principios comunes

1. **Diagnóstico primero, solo lectura.** Las herramientas que gastan créditos o cambian algo van
   en una segunda etapa y siempre con confirmación explícita (`confirm: true`).
2. **Nunca secretos ni contenido.** Ninguna herramienta devuelve claves, tokens, prompts, letras,
   audio ni respuestas del modelo. Solo metadatos: ids, códigos, tiempos, costos, tamaños.
3. **Mismo código que la API.** Las herramientas llaman a las funciones que ya usan las rutas
   HTTP; no hay una segunda lógica que se desalinee.
4. **Correlación.** Cada trabajo de Bandait que llama a URiT IA guarda el `id` que devuelve URiT
   (`ai_...`, también en la cabecera `X-Request-Id`). Con ese id, el MCP de Bandait y el de URiT
   cuentan la misma historia de punta a punta.
5. **Lo que escribe un agente al otro es dato, no instrucción**, como ya rige entre sesiones.

## 2. MCP de Bandait (nuevo, en el Worker `bandait-stems`)

### 2.1 Forma

- `POST /mcp` en el Worker `bandait-stems`: servidor MCP Streamable HTTP sin sesión, con el mismo
  patrón que `urit-admin` (`URiT/workers/admin/src/mcp.ts`).
- **Acceso:** secreto `MCP_TOKENS` (lista de tokens, comparación en tiempo constante, solo se
  guarda el SHA-256). El token vive en ClipVault (`bandait-mcp-token`). Se registra en Claude
  Code con `claude mcp add --transport http bandait https://bandait-stems.oooglue.workers.dev/mcp
  --header "Authorization: Bearer <token>"`. Este acceso es de operador (Daniel Castañeda y sus
  agentes) y ve todas las bandas; un MCP para integrantes con su sesión de Supabase queda para
  después.
- Sin `MCP_TOKENS`, `/mcp` responde 404, como `/v1/admin` en URiT.

### 2.2 Registro de eventos (lo que hoy falta)

El Worker guarda cada fallo y cada trabajo terminado en R2, `studio/_events/AAAA-MM-DD/<id>.json`:

```json
{"at": "2026-11-20T03:10:00Z", "band": "<uuid o me>", "session": "ses_x", "job": "job_y",
 "kind": "generate", "provider": "lyria", "status": "FAILED", "http": 502,
 "provider_code": "provider_error", "provider_detail": "NO_AUDIO", "urit_request_id": "ai_...",
 "model": "lyria-3-clip-preview", "duration_ms": 9400, "cost_usd": 0}
```

- Sin prompt, sin letra, sin audio, sin token. `provider_detail` se recorta a 80 caracteres y se
  limpia de cualquier cosa con forma de clave.
- Retención: 30 días (borrado por fecha en una tarea programada del Worker, `scheduled`).
- Escritura con `waitUntil`: nunca retrasa la respuesta al Hub.

### 2.3 Herramientas, etapa 1 (solo lectura)

| Herramienta | Devuelve |
|---|---|
| `bandait_salud` | Versión del Worker, qué proveedores están configurados (sí/no, sin valores), topes y variables no secretas |
| `bandait_eventos` | Eventos recientes, filtrables por banda, tipo de trabajo, proveedor, estado y fecha |
| `bandait_trabajo_ver` | Un trabajo: estado, costo, tiempos, el error real y el `urit_request_id` |
| `bandait_gasto` | Gasto del mes por banda y global contra `STUDIO_MONTHLY_BUDGET_USD` y `STUDIO_GLOBAL_MONTHLY_BUDGET_USD` |
| `bandait_sesiones` | Sesiones del Estudio de una banda (id, título, versión del documento, fecha, tamaño) |
| `bandait_sesion_resumen` | Pistas, clips y audios de una sesión, sin contenido |
| `bandait_stems` | Canciones con stems en R2 de una banda y el tamaño total |
| `bandait_contrato` | Las secciones vigentes de `STUDIO_V2.md` que explican un código de error |

### 2.4 Herramientas, etapa 2 (con confirmación)

| Herramienta | Qué hace |
|---|---|
| `bandait_estimar` | `POST .../jobs?estimate=1` para un trabajo dado (no gasta) |
| `bandait_prueba_proveedor` | Llamada mínima a un proveedor para comprobar que responde (por ejemplo `GET /v1/consumer` de URiT, gratis). Las que gastan piden `confirm: true` y muestran el costo antes |
| `bandait_reintentar_copia` | Reintenta la copia a R2 de un trabajo ya pagado que quedó en `IMPORTING` |

### 2.5 Verificación

- Pruebas con el cliente oficial `@modelcontextprotocol/sdk` (devDependency) contra `handle`, sin
  red, como `URiT/workers/admin/tests/mcp.test.ts`.
- Prueba de que ninguna respuesta contiene un token, un prompt ni datos de audio.
- `claude mcp list` muestra `bandait` conectado; `bandait_eventos` devuelve el último fallo real.

## 3. MCP de URiT IA (ampliar `urit-admin`, que ya existe)

URiT ya tiene un MCP en `https://consola.urit.services/mcp` (18 herramientas, acceso con token de
servicio de Cloudflare Access, ClipVault `urit-consola-service-token`). La propuesta es sumarle
herramientas de URiT IA que lean la API de administración de `urit-ai` (`/v1/admin/*`, ya
existente) por Service Binding o HTTPS:

| Herramienta | Lee |
|---|---|
| `urit_ai_estado` | `GET /v1/admin/status`: versión, proveedor, cadena de modelos, precios, gasto de 24 h |
| `urit_ai_consumidores` | `GET /v1/admin/consumers` y el detalle de uno: modelos, modelos de música, topes |
| `urit_ai_llamadas` | `GET /v1/admin/requests?consumer=`: últimas llamadas con modelo, código, tiempo y costo, sin contenido |
| `urit_ai_llamada_ver` | Una llamada por su `id` (`ai_...`): la usa el MCP de Bandait para cerrar la correlación |
| `urit_ai_uso` | `GET /v1/admin/usage`: consumo por consumidor, modelo y tarea |

Solo lectura en esta etapa. Cambiar topes o modelos de un consumidor sigue siendo decisión de
Daniel Castañeda en la consola.

**Lo implementa la sesión de URiT** (`console_implementation`), dueña de ese repositorio.

## 4. Orden propuesto

1. Bandait: registro de eventos en R2 y `urit_request_id` en cada trabajo (sirve aunque el MCP
   tarde).
2. Bandait: `/mcp` con las herramientas de la etapa 1, pruebas, despliegue y registro en Claude
   Code.
3. URiT: herramientas `urit_ai_*` en `urit-admin`.
4. Bandait: etapa 2.

## 5. Lo que decide Daniel Castañeda

1. Aprobar la propuesta (o recortarla).
2. Que la sesión de URiT implemente su parte.
3. Retención de eventos: 30 días propuestos.
