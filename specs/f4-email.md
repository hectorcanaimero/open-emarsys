---
type: spec
project_id: open-emarsys
phase: 4
version: 0.1
depends_on:
  - docs/arch/001-open-emarsys.md
  - docs/prd/001-open-emarsys.md
consumed_by:
  - orch-atomizer
generated_by: orch-spec
generated_at: 2026-09-17
title: Email de punta a punta
---

# F4 — Email de punta a punta

Milestone M4 del PRD (FR-27 a FR-37, NFR-4, NFR-6, NFR-11). Nacen cuatro servicios: content (NestJS), campaigns (NestJS), dispatcher (Go) y tracker (Go). Contratos en `docs/arch/001-open-emarsys.md` §Interfaces C1, C2, C4, C8, C9 y C11. Regla transversal: **el único renderizador de personalización es dispatcher (D6)**; content solo valida sintaxis. `pnpm-workspace.yaml` usa globs (`services/*`) desde F0.1, así que los scaffolds NestJS no lo editan; `go.work` lo edita solo F4.3.T1.

## F4.1 — Package: contracts email

### F4.1.T1 — Contrato de personalización Liquid y fixtures de render

Escribir `contracts/dsl/personalization.md` exactamente como fija C8: variables `contact.<api_name>` y `contact.f<field_id>`, `event.*`, bloques reservados `recs` (F6) y `loyalty` (F9) documentados como "no disponibles hasta su fase", tags permitidos (`if/elsif/else`, `for` con `limit`, `unless`, `assign`), filtros permitidos (`default, upcase, downcase, capitalize, date, money, truncate, url_encode`) con su semántica por locale y zona horaria del contacto (NFR-16), y la regla "variable desconocida → vacío + entrada en `errors[]`". Crear fixtures en `contracts/dsl/fixtures/render/`: cada caso es un par `<nombre>.input.json` (`{template:{subject,html,text}, contact, event, locale, timezone}`) y `<nombre>.expected.json` (`{subject, html, text, errors}`). Mínimo 20 casos: default con campo faltante (el ejemplo de FR-28), condicionales, bucles, cada filtro, variable desconocida, tag prohibido (debe fallar con error tipado), escape HTML de valores del contacto. Cubre FR-28.

Done when: `pnpm --filter ts-contracts test:fixtures` (o el script de validación de contracts de F0.3) valida que todos los `input.json`/`expected.json` son JSON válidos y que cada input tiene su expected; el documento lista los 8 filtros y los tags permitidos.

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Contrato compartido entre Node (validación) y Go (render); una ambigüedad aquí produce divergencias en todo F4–F9.
- **Dependencies**: F3.5.T1
- **Files**:
  - `contracts/dsl/personalization.md`
  - `contracts/dsl/fixtures/render/`

### F4.1.T2 — Token de tracking y eventos messages.*

Especificar el token de tracking C9 en `contracts/dsl/tracking-token.md`: layout binario del payload (`v, t, m, c, k, l`), codificación base64url, HMAC-SHA256 truncado a 16 bytes, derivación de la llave por tenant con HKDF-SHA256 desde la clave maestra (`info = "oe-track:" + tenant_id`), y vectores de prueba (clave maestra, tenant, payload → token esperado). Agregar la estructura del registro Redis `link:<message_id>` que escribe dispatcher al renderizar: `{sent_at, urls:[...]}` (tracker usa `sent_at` para detectar escáneres). Escribir los JSON Schema de los eventos de C1 de F4 sobre el envelope `contracts/events/envelope.schema.json`: `messages.send.requested`, `messages.sent`, `messages.failed`, `messages.delivered`, `messages.opened`, `messages.clicked`, `messages.bounced`, `messages.complained` y `messages.unsubscribed`, cada uno con un ejemplo en `contracts/events/examples/`. `messages.send.requested` agrega `test: bool` y `to_override: string[]` para envíos de prueba (FR-30). Cubre FR-34, FR-35 y NFR-11 (el `message_id` es la llave de idempotencia).

Done when: el validador de contracts de CI pasa con los 9 esquemas y sus ejemplos, y los vectores de prueba del token están en el documento.

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Formato criptográfico y contratos de eventos que consumen cuatro servicios; es sensible a seguridad.
- **Dependencies**: F3.5.T1
- **Files**:
  - `contracts/dsl/tracking-token.md`
  - `contracts/events/messages.send.requested.schema.json`
  - `contracts/events/messages.sent.schema.json`
  - `contracts/events/messages.failed.schema.json`
  - `contracts/events/messages.delivered.schema.json`
  - `contracts/events/messages.opened.schema.json`
  - `contracts/events/messages.clicked.schema.json`
  - `contracts/events/messages.bounced.schema.json`
  - `contracts/events/messages.complained.schema.json`
  - `contracts/events/messages.unsubscribed.schema.json`
  - `contracts/events/examples/`

### F4.1.T3 — OpenAPI de content

Escribir `contracts/openapi/admin-v1/content.yaml` (C3: JSON plano, problem+json, cursor): plantillas (CRUD con `tree` de bloques), esquema del árbol de bloques (`text, image, button, columns, divider, spacer, html`, más `products` reservado para F6), bloques compartidos (CRUD; un bloque de plantilla puede ser `{type:"shared", shared_block_id}`), assets (subida multipart y URL firmada, listado, borrado), publicación de versión (`POST /templates/{id}/versions` → content_version), vista previa (`POST /content/preview` con `{template_id | tree, contact_id?, sample_context}` → `{subject, html, text, errors[]}`, que content resuelve compilando y delegando la personalización a dispatcher) y envío de prueba (`POST /templates/{id}/send-test` con `{addresses[] | list_id, contact_id}`). Escribir `contracts/openapi/internal/content.yaml` con `GET /internal/v1/content-versions/{id}` como fija C4. Cubre FR-27, FR-29 y FR-30.

Done when: `npx @redocly/cli lint contracts/openapi/admin-v1/content.yaml contracts/openapi/internal/content.yaml` pasa sin errores.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2.5h
- **Reason**: Diseño de API REST convencional a partir de un contrato ya fijado en el arch.
- **Dependencies**: F3.5.T1
- **Files**:
  - `contracts/openapi/admin-v1/content.yaml`
  - `contracts/openapi/internal/content.yaml`

### F4.1.T4 — OpenAPI de campaigns, dispatcher y API pública de email

Escribir `contracts/openapi/admin-v1/campaigns.yaml`: campañas (CRUD, `channel=email`, `audience {segment_id | list_id}`, `schedule {mode: immediate|at|contact_timezone, at, local_time}`, `sender_id`, `ab {enabled, test_percent, metric: open|click, wait_hours, variants[]}`), lanzamiento, cancelación, response summary (envíos, entregas, aperturas únicas y totales, clicks por enlace, bounces duros/blandos, quejas, bajas, excluidos por motivo), dominios de envío (alta, registros DNS a crear, verificación) y remitentes. Agregar a `contracts/openapi/public-v3.yaml` la sección email de C2: `GET/POST /email`, `POST /email/{id}/launch`, `POST /email/{id}/sendtestmail`, `GET /email/{id}/responsesummary`, `POST /email/transactional` (`{event_id | campaign_id, key_id, external_id, data}`), con el envelope `replyCode`. Escribir `contracts/openapi/internal/campaigns.yaml` (`GET /internal/v1/senders/{id}`) y `contracts/openapi/internal/dispatcher.yaml` (`POST /internal/v1/render`, `POST /internal/v1/send-test`) tal como C4. Cubre FR-30, FR-31, FR-33, FR-34, FR-36 y FR-37.

Done when: redocly lint pasa sobre los cuatro archivos.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Volumen de API mayor, pero sin decisiones de diseño abiertas.
- **Dependencies**: F3.5.T1
- **Files**:
  - `contracts/openapi/admin-v1/campaigns.yaml`
  - `contracts/openapi/public-v3.yaml`
  - `contracts/openapi/internal/campaigns.yaml`
  - `contracts/openapi/internal/dispatcher.yaml`

### F4.1.T5 — Regenerar tipos de contratos TypeScript

Correr el codegen de F0.3 (`scripts/codegen/`) para generar en `packages/ts-contracts` los tipos y clientes de los OpenAPI nuevos (content, campaigns, internos) y los tipos de los eventos `messages.*`. No escribir tipos a mano.

Done when: `pnpm --filter ts-contracts build` compila y exporta `ContentApi`, `CampaignsApi` y `MessagesSendRequested`.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 1h
- **Reason**: Paso mecánico de codegen.
- **Dependencies**: F4.1.T2, F4.1.T3, F4.1.T4
- **Files**:
  - `packages/ts-contracts/src/generated/`

## F4.2 — Package: content service

### F4.2.T1 — Scaffold del servicio content

Crear el servicio NestJS `services/content` con la misma estructura que core (F0.6): `package.json` (dependencias `@oe/ts-common`, `@oe/ts-contracts`, Prisma, `mjml`, `liquidjs` solo para el parser de sintaxis, cliente MinIO), `tsconfig.json`, `src/main.ts` con OTel (NFR-12), guard JWT/JWKS y permisos de `packages/ts-common`, extensión Prisma RLS (NFR-8), `/health`, Prisma multiarchivo en `prisma/schema/base.prisma` (schema Postgres `content`, rol `content`), `src/app.module.ts` con los módulos comunes y sin módulos de dominio, y un `Dockerfile` multi-stage. No editar `pnpm-workspace.yaml` ni la compose raíz.

Done when: `pnpm --filter content build` compila y `pnpm --filter content test` corre un test de `/health`.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 2h
- **Reason**: Boilerplate que replica el patrón de core.
- **Dependencies**: F4.1.T5
- **Files**:
  - `services/content/package.json`
  - `services/content/tsconfig.json`
  - `services/content/src/main.ts`
  - `services/content/src/app.module.ts`
  - `services/content/prisma/schema/base.prisma`
  - `services/content/Dockerfile`
  - `services/content/test/health.e2e-spec.ts`

### F4.2.T2 — Plantillas y bloques compartidos

Módulo `templates`: tablas `templates` y `shared_blocks` del Data model (schema `content`), CRUD según `contracts/openapi/admin-v1/content.yaml`, validación del árbol de bloques contra el esquema del contrato y permisos `email:view` y `email:edit`. Un bloque `{type:"shared"}` referencia `shared_block_id` y se resuelve al compilar, no al guardar. Así, editar un bloque compartido cambia la vista previa de toda plantilla que lo use sin versión enviada (FR-29). Cada escritura va al audit log (FR-6). Cubre FR-27 y FR-29.

Done when: tests de integración (Postgres de test) cubren crear plantilla, rechazo de árbol inválido, CRUD de bloque compartido y 404 al leer una plantilla de otro tenant.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: CRUD NestJS con validación de esquema; nivel estándar.
- **Dependencies**: F4.2.T1
- **Files**:
  - `services/content/src/modules/templates/`
  - `services/content/prisma/schema/templates.prisma`

### F4.2.T3 — Biblioteca de assets

Módulo `assets`: subida multipart (máximo 5 MB; `image/png`, `image/jpeg`, `image/gif`, `image/webp`) al bucket MinIO `assets` con key `<tenant_id>/<uuidv7>.<ext>`, lectura de dimensiones, tabla `assets`, listado paginado por cursor, borrado y URL pública para usar en emails. Verificar el MIME real por magic bytes, no por extensión (NFR-9). Cubre FR-29.

Done when: tests de integración con MinIO (testcontainers) suben un PNG, lo listan con ancho y alto, rechazan un `.png` que en realidad es texto y no lo muestran a otro tenant.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Integración S3 estándar con validación de entrada.
- **Dependencies**: F4.2.T1
- **Files**:
  - `services/content/src/modules/assets/`
  - `services/content/prisma/schema/assets.prisma`

### F4.2.T4 — Compilador bloques → MJML → HTML y validador Liquid

Módulo `compiler`: función pura `compile(tree, sharedBlocks) → {html, text, variables[], errors[]}`. Convierte cada bloque a MJML, compila con `mjml` (`validationLevel: strict`, falla ante errores), genera la versión texto y extrae las variables usadas. Valida la sintaxis de personalización contra el subconjunto de C8 (`contracts/dsl/personalization.md`) usando solo el parser: tags o filtros fuera del subconjunto son error. **No renderiza valores** (D6). Resolver bloques `shared`. Cubre FR-27 y FR-28 (validación).

Done when: tests unitarios compilan un árbol con cada tipo de bloque (snapshot del HTML), rechazan un filtro no permitido y un `{% include %}`, y extraen `contact.first_name` y `event.payload.tracking` como variables. Los templates de `contracts/dsl/fixtures/render/*.input.json` marcados como válidos pasan la validación.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Lógica de transformación con tests de snapshot; no es sensible a seguridad.
- **Dependencies**: F4.2.T1, F4.1.T1
- **Files**:
  - `services/content/src/modules/compiler/`

### F4.2.T5 — Versiones inmutables, vista previa, envío de prueba y API interna

Módulo `versions`: `POST /templates/{id}/versions` compila con F4.2.T4 (rechaza con 422 si hay errores) y guarda una fila inmutable en `content_versions` (sin UPDATE; test que lo prueba). `GET /internal/v1/content-versions/{id}` (C4) con token `typ=service`. `POST /content/preview` compila el árbol o la plantilla y delega el render a `POST /internal/v1/render` de dispatcher (`draft{subject, html, text}`), devolviendo su respuesta. `POST /templates/{id}/send-test` publica la versión si hace falta y llama a `POST /internal/v1/send-test`. Cubre FR-27 (vista previa), FR-29 y FR-30.

Done when: tests de integración cubren publicar versión, 422 ante una plantilla inválida, lectura interna rechazada sin token de servicio, y preview/send-test contra un mock HTTP de dispatcher.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Orquestación entre módulos y un servicio externo; nivel estándar.
- **Dependencies**: F4.2.T2, F4.2.T4
- **Files**:
  - `services/content/src/modules/versions/`
  - `services/content/prisma/schema/versions.prisma`

### F4.2.T6 — Wiring de módulos de content y tests de acceso cruzado

Registrar `templates`, `assets`, `compiler` y `versions` en `src/app.module.ts` (única tarea que lo edita, regla C11), generar la migración Prisma inicial del schema `content` con políticas RLS por tabla, y agregar la suite de acceso cruzado de NFR-8: con dos tenants, toda ruta de `/admin/v1` de content devuelve 404 o lista vacía sobre recursos ajenos.

Done when: `pnpm --filter content test` y `pnpm --filter content test:e2e` pasan, y la migración aplica sobre un Postgres limpio.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Integración y tests de seguridad multi-tenant; estándar con criterios claros.
- **Dependencies**: F4.2.T3, F4.2.T5
- **Files**:
  - `services/content/src/app.module.ts`
  - `services/content/prisma/migrations/`
  - `services/content/test/cross-tenant.e2e-spec.ts`

## F4.3 — Package: dispatcher

### F4.3.T1 — Scaffold del servicio dispatcher y go.work

Crear el módulo Go `services/dispatcher` (`go.mod` con `replace` hacia `libs/go/oe`), `cmd/dispatcher/main.go` mínimo (config, logger, OTel, `/health` usando `libs/go/oe`), `internal/config/`, migración SQL de la tabla `dispatcher.sends` (Data model: PK `message_id`) en `migrations/`, y `Dockerfile` distroless. Agregar a `go.work` **tanto `./services/dispatcher` como `./services/tracker`**: tracker se scaffoldea en paralelo y así ninguna otra tarea de F4 edita `go.work`. Crear `services/tracker/go.mod` vacío con solo la línea `module` para que `go.work` resuelva.

Done when: `go build ./services/dispatcher/...` y `go work sync` pasan, y `go test ./services/dispatcher/...` corre el test de `/health`.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 1.5h
- **Reason**: Scaffold mecánico siguiendo el patrón de collector.
- **Dependencies**: F4.1.T2
- **Files**:
  - `go.work`
  - `services/dispatcher/go.mod`
  - `services/dispatcher/cmd/dispatcher/main.go`
  - `services/dispatcher/internal/config/`
  - `services/dispatcher/migrations/`
  - `services/dispatcher/Dockerfile`
  - `services/tracker/go.mod`

### F4.3.T2 — Motor de render Liquid

Paquete `internal/render` con `osteele/liquid` restringido al subconjunto de C8: registrar solo los filtros permitidos (implementando `money` y `date` con locale y zona horaria del contacto), rechazar tags no permitidos antes de renderizar, resolver `contact.<api_name>` y `contact.f<field_id>` desde el mapa de campos del contacto más las definiciones de campos, exponer `event.*`, escapar HTML en valores interpolados dentro de `html` pero no en `text`, y acumular variables desconocidas en `errors[]` renderizándolas vacías. API: `Render(ctx, tpl Template, data Context) (Result, error)`. Cubre FR-28 y NFR-16.

Done when: `go test ./services/dispatcher/internal/render/...` recorre **todos** los fixtures de `contracts/dsl/fixtures/render/` y compara el resultado exacto con cada `expected.json`.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Implementación guiada por fixtures ya definidos.
- **Dependencies**: F4.3.T1, F4.1.T1
- **Files**:
  - `services/dispatcher/internal/render/`

### F4.3.T3 — Tokens de tracking y reescritura de enlaces

Crear `libs/go/oe/tracktoken` con `Sign(master, payload) string` y `Verify(master, token) (Payload, error)` según `contracts/dsl/tracking-token.md` (HKDF por tenant, HMAC-SHA256 truncado, comparación en tiempo constante), probado con los vectores del documento. En `services/dispatcher/internal/tracking`: reescribir cada `href` http(s) del HTML renderizado a `/t/c/{token}` con `link_idx`, sin tocar `mailto:` ni los links de baja y preferencias, insertar el pixel `/t/o/{token}` antes de `</body>`, y guardar en Redis `link:<message_id>` = `{sent_at, urls}` con TTL de 400 días (C9). Cubre FR-34 y NFR-9.

Done when: `go test ./libs/go/oe/tracktoken/... ./services/dispatcher/internal/tracking/...` pasa: vectores de prueba, rechazo de token alterado y de token de otro tenant, y golden test de un HTML reescrito.

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Criptografía (HKDF/HMAC, tiempo constante); un error permite falsificar clicks o bajas.
- **Dependencies**: F4.3.T1
- **Files**:
  - `libs/go/oe/tracktoken/`
  - `services/dispatcher/internal/tracking/`

### F4.3.T4 — Pipeline de envío: idempotencia, supresión y consumo

Paquete `internal/pipeline`: consumidor durable JetStream `dispatcher-send` sobre `oe.messages.send.requested.*` (C1) con ack manual. Por mensaje:

1. Idempotencia: `INSERT ... ON CONFLICT (message_id) DO NOTHING` en `dispatcher.sends`; si ya existe en estado `sent`, ack sin reenviar (NFR-11).
2. Consentimiento y supresión con la caché Redis `supp:<tenant>:<channel>`, alimentada por los consumidores `dispatcher-consent` (`oe.consent.changed.*`) y `dispatcher-suppression` (`oe.messages.bounced.*` duro, `.complained.*`, `.unsubscribed.*`) (FR-32).
3. Carga de la content version (LRU de 1.000 entradas + `GET /internal/v1/content-versions/{id}`).
4. Datos del contacto en lotes con `POST /internal/v1/contacts/lookup` de core.
5. Render (F4.3.T2) y reescritura (F4.3.T3).
6. Entrega al adaptador de canal detrás de una interfaz `Channel`.
7. Publicación de `messages.sent` o `messages.failed` y actualización de `sends`.

`test=true` usa `to_override`, omite la supresión y marca el asunto con `[TEST]` (FR-30). Excluidos por supresión publican `messages.failed` con `error=suppressed:<motivo>`. Cubre FR-32 y NFR-11.

Done when: tests de integración (NATS, Postgres y Redis en testcontainers, canal fake) prueban que el mismo `message_id` publicado dos veces genera una sola entrega, que un contacto suprimido no recibe y publica `failed`, y que reiniciar el consumidor a mitad de lote no pierde ni duplica mensajes.

- **Model**: claude/claude-opus-5
- **Estimate**: 4h
- **Reason**: Garantías de idempotencia y durabilidad bajo reintentos; un bug aquí envía duplicados a clientes reales.
- **Dependencies**: F4.3.T2, F4.3.T3
- **Files**:
  - `services/dispatcher/internal/pipeline/`
  - `services/dispatcher/internal/suppression/`
  - `services/dispatcher/internal/clients/`

### F4.3.T5 — Adaptador de email: SMTP, SES, DKIM y List-Unsubscribe

Paquete `internal/channels/email` que implementa `Channel`. Obtiene el remitente con `GET /internal/v1/senders/{id}` (caché de 5 min), arma el MIME multipart (text + html) con `From`, `Reply-To` y `Message-ID` derivado del `message_id`, agrega `List-Unsubscribe: <https://.../t/u/{token}>, <mailto:...>` y `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (FR-35), firma DKIM con `emersion/go-msgauth` usando selector y llave del remitente (FR-36), y envía por SMTP (Mailpit en desarrollo) o por la API SESv2 según la config del tenant. Incluye un adaptador `fake` que registra en memoria para tests. Distingue fallos permanentes (5xx) de temporales (4xx, timeouts).

Done when: test de integración contra Mailpit verifica que el email recibido tiene ambos headers de List-Unsubscribe y una firma DKIM que verifica con la llave pública; hay un test unitario de clasificación de errores.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Integración de protocolo con librerías maduras; estándar.
- **Dependencies**: F4.3.T3
- **Files**:
  - `services/dispatcher/internal/channels/email/`

### F4.3.T6 — Throttling por tenant y dominio destino

Paquete `internal/throttle`: token bucket atómico en Redis (script Lua) con llaves `rl:tenant:<tenant>:<channel>` y `rl:domain:<domain>`. Límites configurables por tenant (desde `tenants.limits`) y por dominio (defaults: gmail.com 50/s, outlook.com 30/s, resto 100/s). Si no hay token, el mensaje se reprograma con `NakWithDelay` sin contar como intento fallido. Reintentos de fallos temporales con backoff exponencial, hasta 5 intentos. Cubre NFR-6.

Done when: test con Redis en testcontainers: con límite 10/s, 100 solicitudes concurrentes se distribuyen en ~10 s (±10%) y ninguna se pierde.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Algoritmo conocido con test de tiempos; estándar.
- **Dependencies**: F4.3.T1
- **Files**:
  - `services/dispatcher/internal/throttle/`

### F4.3.T7 — API interna de render y envío de prueba

Paquete `internal/api`: `POST /internal/v1/render` y `POST /internal/v1/send-test` según `contracts/openapi/internal/dispatcher.yaml` (C4), protegidos con token `typ=service` (`libs/go/oe` auth). `render` acepta `content_version_id` o `draft`, `contact_id` opcional (datos reales vía core) o `sample_context`, y devuelve `{subject, html, text, errors[]}` sin reescribir enlaces. `send-test` publica `messages.send.requested` con `test=true`, `to_override` y un `message_id` nuevo, para ejercitar el mismo pipeline. Cubre FR-27 (vista previa), FR-28 y FR-30.

Done when: tests HTTP cubren render de borrador con contacto de muestra, 401 sin token de servicio, y que send-test publica un evento que valida contra `messages.send.requested.schema.json`.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Handlers HTTP finos sobre paquetes existentes.
- **Dependencies**: F4.3.T2, F4.3.T4
- **Files**:
  - `services/dispatcher/internal/api/`

### F4.3.T8 — Ensamblado de dispatcher y test de punta a punta del servicio

Completar `cmd/dispatcher/main.go` y `internal/app`: construir pipeline, adaptador de email, throttle y API; registrar métricas OTel (`dispatcher_sent_total`, `dispatcher_send_latency`, `dispatcher_suppressed_total`); apagado ordenado que drena el consumidor. Test de integración del binario con NATS, Postgres, Redis y Mailpit: publicar 50 `send.requested` para contactos de un core simulado y verificar 50 emails en Mailpit con pixel y enlaces reescritos. Cubre NFR-6, NFR-11 y NFR-12.

Done when: `go test -tags=integration ./services/dispatcher/test/...` pasa.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Integración con criterios definidos.
- **Dependencies**: F4.3.T5, F4.3.T6, F4.3.T7
- **Files**:
  - `services/dispatcher/cmd/dispatcher/main.go`
  - `services/dispatcher/internal/app/`
  - `services/dispatcher/test/`

## F4.4 — Package: tracker

### F4.4.T1 — Scaffold del servicio tracker

Completar el módulo Go `services/tracker` (su `go.mod` y la entrada en `go.work` ya los creó F4.3.T1; no editar `go.work`): `cmd/tracker/main.go` mínimo con config, logger, OTel, `/health` y router HTTP de stdlib, `internal/config/` y `Dockerfile` distroless.

Done when: `go build ./services/tracker/...` pasa y hay un test de `/health`.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 1h
- **Reason**: Boilerplate.
- **Dependencies**: F4.3.T1
- **Files**:
  - `services/tracker/cmd/tracker/main.go`
  - `services/tracker/internal/config/`
  - `services/tracker/Dockerfile`

### F4.4.T2 — Endpoints de apertura, click, baja y preferencias

Paquete `internal/http` con los endpoints de C9 usando `libs/go/oe/tracktoken`:

- `GET /t/o/{token}`: GIF 1×1 con `Cache-Control: no-store`.
- `GET /t/c/{token}`: 302 a la URL `link_idx` de `link:<message_id>`; token inválido → 404 sin redirigir (evita open redirect).
- `POST /t/u/{token}`: one-click, 200 sin login.
- `GET /t/u/{token}`: página mínima de confirmación con botón POST.
- `GET /t/pref/{token}`: 302 a `admin-web /preferences/{token}`.
- `POST /t/pref/{token}`: recibe `{channels:{email:bool,sms:bool,push:bool}}` desde el centro de preferencias y publica `messages.unsubscribed` por cada canal desactivado.

Publica `messages.opened`, `.clicked` y `.unsubscribed` en NATS de forma asíncrona (buffer en memoria con flush cada 50 ms o 500 eventos): la respuesta HTTP nunca espera a NATS (NFR-4). Cubre FR-34 y FR-35.

Done when: tests HTTP cubren pixel válido (200 + evento publicado), click con redirect correcto, token alterado → 404, one-click POST → evento `unsubscribed`, y un benchmark Go `BenchmarkOpen` con < 1 ms por request sin red.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Handlers de alto volumen con requisitos de seguridad acotados por la librería de tokens.
- **Dependencies**: F4.4.T1, F4.3.T3
- **Files**:
  - `services/tracker/internal/http/`

### F4.4.T3 — Detección de aperturas de máquina

Paquete `internal/machine`: `Classify(req, linkRecord) bool`. Marca `machine=1` si la IP está en los rangos de Apple Private Relay/MPP (lista embebida con script de actualización), si el UA es un escáner conocido (Proofpoint, Mimecast, Barracuda, Microsoft Defender) o si faltan menos de 2 s desde `sent_at` del registro `link:<message_id>`. La clasificación viaja en el campo `machine` de `messages.opened` y `messages.clicked`. Cubre FR-34.

Done when: tests de tabla cubren una IP de MPP, un UA de escáner, una apertura a 1 s del envío y una apertura humana normal.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Heurística simple con tests de tabla.
- **Dependencies**: F4.4.T1
- **Files**:
  - `services/tracker/internal/machine/`
  - `services/tracker/scripts/update-apple-ranges.sh`

### F4.4.T4 — Webhooks de proveedor: SES vía SNS

Paquete `internal/webhooks`: `POST /t/wh/ses` que recibe notificaciones SNS, **verifica la firma SNS** (descarga del certificado solo desde `sns.<region>.amazonaws.com`, validación de `SignatureVersion` 1 y 2), confirma suscripciones automáticamente y mapea `Bounce` (Permanent → `bounce_type=hard`, Transient → `soft`), `Complaint` y `Delivery` a `messages.bounced`, `.complained` y `.delivered`, usando el `Message-ID` del header para recuperar el `message_id`. Payload sin firma válida → 403. Cubre FR-34 y NFR-9.

Done when: tests con notificaciones SNS reales firmadas (fixtures) publican el evento correcto, y un payload alterado o con certificado de otro host se rechaza con 403.

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Verificación de firmas de terceros; sin ella cualquiera puede suprimir contactos ajenos.
- **Dependencies**: F4.4.T1
- **Files**:
  - `services/tracker/internal/webhooks/`

### F4.4.T5 — Consumidor de supresión en core

En core, `consumers/suppression.consumer.ts` del módulo contacts: consumidor durable `core-suppression` sobre `oe.messages.unsubscribed.*`, `oe.messages.bounced.*` y `oe.messages.complained.*` (C1). Una baja cambia el consentimiento del canal a `2` (no) con `source=unsubscribe` y agrega entrada al historial (FR-14). Un bounce duro o una queja cambia el opt-in email a `2` con `source=bounce|complaint`. Publica `consent.changed` y `contacts.upserted` con la versión incrementada. Idempotente por `event.id`. Registrar el consumidor en `contacts.module.ts`. Cubre FR-32 y FR-35.

Done when: test de integración publica `messages.unsubscribed` y verifica el opt-in email = 2, la entrada de historial y el evento `consent.changed`; reprocesar el mismo evento no duplica el historial.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Consumidor NestJS sobre un módulo existente; estándar.
- **Dependencies**: F4.1.T5
- **Files**:
  - `services/core/src/modules/contacts/consumers/suppression.consumer.ts`
  - `services/core/src/modules/contacts/consumers/suppression.consumer.spec.ts`
  - `services/core/src/modules/contacts/contacts.module.ts`

### F4.4.T6 — Ensamblado de tracker y test de integración

Completar `cmd/tracker/main.go` con router, publicador NATS con buffer, clasificador y webhooks; métricas OTel (`tracker_requests_total`, `tracker_latency`), apagado que hace flush del buffer. Test de integración con NATS y Redis: generar un token con `tracktoken`, sembrar `link:<id>`, abrir y clickear, y verificar ambos eventos en JetStream con `machine` correcto.

Done when: `go test -tags=integration ./services/tracker/test/...` pasa.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Integración de piezas ya probadas.
- **Dependencies**: F4.4.T2, F4.4.T3, F4.4.T4
- **Files**:
  - `services/tracker/cmd/tracker/main.go`
  - `services/tracker/internal/app/`
  - `services/tracker/test/`

### F4.4.T7 — Consumidor sink de message_events

En `services/collector/internal/sink/messages.go`: consumidor durable JetStream `sink-messages` sobre `oe.messages.>` (C1), excluyendo `messages.send.requested` (es un comando, no un hecho). Mapea cada evento a una fila de ClickHouse `message_events`: `kind` = sent, delivered, open, click, bounce_hard/bounce_soft según `bounce_type`, complaint, unsub o failed; más `link_idx`, `machine`, `campaign_id`, `program_id`, `node_id` y `variant_id` cuando vienen en `data`. Escribe por lotes (flush a 1.000 filas o 1 s) con ack del lote después del INSERT exitoso. La deduplicación de reentregas la resuelve `ReplacingMergeTree` o el `id` del envelope. Se registra en el sink con el mecanismo de registro de F2.2 (`sink.Register` en `init()`), sin editar `cmd/sink/main.go`. Cubre FR-34 y FR-60 (datos base) y NFR-11.

Done when: test de integración (NATS y ClickHouse en testcontainers) en `messages_test.go` publica un evento de cada kind y verifica cada fila en `message_events` con sus columnas; reentregar un lote no duplica conteos con `FINAL`.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Consumidor por lotes siguiendo el patrón existente del sink.
- **Dependencies**: F4.1.T2
- **Files**:
  - `services/collector/internal/sink/messages.go`
  - `services/collector/internal/sink/messages_test.go`

## F4.5 — Package: campaigns service

### F4.5.T1 — Scaffold del servicio campaigns

Crear el servicio NestJS `services/campaigns` con el patrón de F4.2.T1: auth/permisos, RLS, OTel, `/health`, Prisma multiarchivo (`prisma/schema/base.prisma`, schema `campaigns`), conexión BullMQ a Redis (D13), cliente gRPC de `segments.v1` (C5) generado desde `proto/`, cliente ClickHouse de solo lectura, `app.module.ts` sin módulos de dominio y `Dockerfile`.

Done when: `pnpm --filter campaigns build` y el test de `/health` pasan.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 2h
- **Reason**: Boilerplate que replica un patrón existente.
- **Dependencies**: F4.1.T5
- **Files**:
  - `services/campaigns/package.json`
  - `services/campaigns/tsconfig.json`
  - `services/campaigns/src/main.ts`
  - `services/campaigns/src/app.module.ts`
  - `services/campaigns/prisma/schema/base.prisma`
  - `services/campaigns/Dockerfile`
  - `services/campaigns/test/health.e2e-spec.ts`

### F4.5.T2 — Dominios de envío y remitentes

Módulo `senders`, tablas `sender_domains` y `senders`:

- Al dar de alta un dominio se genera un par RSA 2048 para DKIM, con la llave privada cifrada con AES-256-GCM usando la clave maestra del entorno (nunca en logs ni en respuestas de `/admin/v1`), y se devuelven los registros DNS a crear (TXT DKIM `<selector>._domainkey`, SPF incluyendo el host de envío, DMARC `p=none` mínimo).
- La verificación consulta DNS (`node:dns/promises`) y marca el estado por registro.
- Un remitente solo puede crearse sobre un dominio `verified`.
- `GET /internal/v1/senders/{id}` (C4) devuelve la llave descifrada solo a tokens `typ=service`.

Cubre FR-36 y NFR-9.

Done when: tests con un resolver DNS simulado cubren dominio sin DKIM → no verificado y remitente rechazado; con todos los registros → verificado; la llave privada nunca aparece en respuestas admin (test explícito); y la lectura interna sin token de servicio da 401.

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Manejo de llaves privadas y cifrado en reposo.
- **Dependencies**: F4.5.T1
- **Files**:
  - `services/campaigns/src/modules/senders/`
  - `services/campaigns/prisma/schema/senders.prisma`

### F4.5.T3 — Campañas, variantes y agenda

Módulo `campaigns`, tablas `campaigns` y `variants`: CRUD según `contracts/openapi/admin-v1/campaigns.yaml` y la sección email de la API pública (`GET/POST /api/v3/email`, envelope C2). Validar que `sender_id` existe, `content_version_id` existe (lookup interno a content), la audiencia referencia un segmento o una lista, y la agenda es coherente (fecha futura; `contact_timezone` exige `local_time`). Estados: `draft → scheduled → sending → sent | cancelled`. Permisos `campaigns:view`, `campaigns:edit` y `campaigns:launch` (FR-2). Cubre FR-31.

Done when: tests de integración cubren crear campaña, rechazar un remitente inexistente, transiciones de estado inválidas → 409, y que un usuario sin `campaigns:launch` recibe 403.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: CRUD con máquina de estados; estándar.
- **Dependencies**: F4.5.T1
- **Files**:
  - `services/campaigns/src/modules/campaigns/`
  - `services/campaigns/prisma/schema/campaigns.prisma`

### F4.5.T4 — Lanzamiento con exclusiones y agenda por zona horaria

Módulo `launch`:

1. `POST /email/{id}/launch` (admin y público) llama a `segments.Materialize` (gRPC C5) o resuelve la lista, y guarda `launches`.
2. Pagina `segment_members` junto con `contacts_replica` en ClickHouse, en bloques de 5.000.
3. Excluye en origen, con conteo por motivo en `launches.excluded`: opt-in email ≠ 1 (field 31), email vacío y emails duplicados (FR-32).
4. Publica `messages.send.requested` por contacto con `message_id = uuidv5(launch_id + contact_id)` (NFR-11).
5. `schedule.mode=at` encola un job BullMQ delayed.
6. `contact_timezone` agrupa contactos por zona horaria y encola un job por zona para las `local_time` de cada una (FR-31).

Si el proceso se reinicia a mitad de camino, al reanudar el job continúa desde el último bloque confirmado.

Done when: tests de integración (ClickHouse, NATS y Redis en testcontainers) prueban que un contacto con opt-in = 2 no genera send request y figura en `excluded.consent`; que relanzar tras un crash simulado no cambia los `message_id`; y que con dos zonas horarias se crean dos jobs con el delay correcto.

- **Model**: claude/claude-opus-5
- **Estimate**: 4h
- **Reason**: Envío masivo reanudable con idempotencia y zonas horarias; los errores son costosos.
- **Dependencies**: F4.5.T3
- **Files**:
  - `services/campaigns/src/modules/launch/`
  - `services/campaigns/prisma/schema/launch.prisma`

### F4.5.T5 — Test A/B con ganador automático

Módulo `ab`. Si `ab.enabled`, el lanzamiento reparte `test_percent` de la audiencia entre las variantes (asignación determinista por hash de `contact_id`) y encola un job BullMQ a `wait_hours`. Al vencer, calcula la tasa de apertura o click única por variante desde `message_events` (excluyendo `machine=1`), marca `is_winner` y envía la variante ganadora al resto de la audiencia reutilizando el lanzamiento de F4.5.T4. En empate gana la primera variante. Cubre FR-33.

Done when: test de integración con eventos sembrados en ClickHouse: 20% de prueba, la variante B con más aperturas humanas gana y el 80% restante recibe solo B.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Lógica acotada encima del lanzamiento.
- **Dependencies**: F4.5.T4
- **Files**:
  - `services/campaigns/src/modules/ab/`

### F4.5.T6 — Emails transaccionales disparados por External Event

Módulo `transactional`. Una campaña con `trigger_event_id` queda activa como transaccional. Consumidor durable `campaigns-transactional` sobre `oe.external_event.triggered.*`: busca las campañas activas del evento y publica `messages.send.requested` con `context.event = payload` y `message_id = uuidv5(event.id + campaign_id)`. `POST /api/v3/email/transactional` hace lo mismo sincrónicamente para una campaña explícita. El consentimiento lo sigue validando dispatcher. Objetivo: < 30 s de punta a punta. Cubre FR-37.

Done when: test de integración: publicar `external_event.triggered` de `order_shipped` con `{tracking:"X"}` produce un send request con ese contexto, y republicar el mismo evento no produce un segundo `message_id`.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2.5h
- **Reason**: Consumidor más endpoint con idempotencia simple.
- **Dependencies**: F4.5.T3
- **Files**:
  - `services/campaigns/src/modules/transactional/`

### F4.5.T7 — Response summary y envío de prueba de campaña

Módulo `reporting`. `GET /email/{id}/responsesummary` (admin y público) consulta `message_events` en ClickHouse: envíos, entregas, aperturas únicas y totales (humanas y de máquina por separado), clicks únicos y por `link_idx`, bounces duros y blandos, quejas, bajas, y los excluidos de `launches`. `POST /email/{id}/sendtestmail` delega en dispatcher `/internal/v1/send-test` con la variante elegida y un contacto opcional. Cubre FR-30 y FR-34.

Done when: test de integración con eventos sembrados verifica cada contador contra un conteo directo en SQL, y sendtestmail llama al mock de dispatcher con el payload correcto.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Consultas agregadas y proxy HTTP; estándar.
- **Dependencies**: F4.5.T3
- **Files**:
  - `services/campaigns/src/modules/reporting/`

### F4.5.T8 — Wiring de campaigns y tests de acceso cruzado

Registrar `senders`, `campaigns`, `launch`, `ab`, `transactional` y `reporting` en `src/app.module.ts` (única tarea que lo edita), generar la migración Prisma con RLS del schema `campaigns` y agregar la suite de acceso cruzado de NFR-8 sobre todas las rutas admin y públicas.

Done when: `pnpm --filter campaigns test` y `test:e2e` pasan, y la migración aplica en un Postgres limpio.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Integración y tests de seguridad multi-tenant.
- **Dependencies**: F4.5.T2, F4.5.T5, F4.5.T6, F4.5.T7
- **Files**:
  - `services/campaigns/src/app.module.ts`
  - `services/campaigns/prisma/migrations/`
  - `services/campaigns/test/cross-tenant.e2e-spec.ts`

## F4.6 — Package: admin-web email

### F4.6.T1 — Componente editor de bloques

Componente `email-editor` en `apps/admin-web/src/components/email-editor/`: lienzo con drag & drop (`@dnd-kit`) de los bloques del esquema de `contracts/openapi/admin-v1/content.yaml` (texto con edición rica mínima, imagen desde la biblioteca, botón, columnas 1–3, divisor, espaciador, HTML libre, bloque compartido), panel de propiedades por bloque e inserción de variables de personalización (lista de campos del tenant). Estado = árbol JSON del contrato (`value`/`onChange`). Accesible por teclado: mover bloques con flechas (NFR-15). Los textos usan claves `email.editor.*` de next-intl. Estructura fija, porque F6 y F10 la extienden: un componente por tipo de bloque en `blocks/<type>.tsx`, registrados en `blocks/index.ts`, y un punto de extensión vacío `ai-slot.tsx` montado en el panel lateral. Cubre FR-27 y FR-28.

Done when: tests con Testing Library cubren agregar, reordenar por teclado y borrar bloques, y que el árbol emitido valida contra el esquema; axe no reporta violaciones en el story del editor.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Componente UI complejo pero sin riesgos de seguridad.
- **Dependencies**: F4.1.T5
- **Files**:
  - `apps/admin-web/src/components/email-editor/`

### F4.6.T2 — Pantallas de email: plantillas, vista previa, assets y prueba

Rutas `(console)/email/`: listado de plantillas, edición con el editor de F4.6.T1, vista previa desktop (600 px) y mobile (375 px) en iframe sandbox usando `POST /admin/v1/content/preview` con un contacto elegible, biblioteca de assets (subida, grilla, selección), biblioteca de bloques compartidos, publicación de versión con errores de compilación visibles, y diálogo de envío de prueba a direcciones o lista semilla con contacto elegido. Cliente tipado de `@oe/ts-contracts`. Cubre FR-27, FR-29 y FR-30.

Done when: test Playwright de componente (backend mockeado con MSW) crea una plantilla, ve la vista previa mobile con el nombre del contacto elegido y envía una prueba.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Pantallas CRUD con integración de API tipada.
- **Dependencies**: F4.6.T1
- **Files**:
  - `apps/admin-web/src/app/[locale]/(console)/email/`

### F4.6.T3 — Asistente de campaña, A/B y resultados

Rutas `(console)/campaigns/`: listado con estado, asistente en pasos (remitente, asunto y preheader, contenido/versión, audiencia con conteo desde segments, agenda inmediata/fecha/hora del contacto), configuración A/B (porcentaje, métrica, espera, variantes), confirmación de lanzamiento (solo con permiso `campaigns:launch`) y página de resultados con los contadores del response summary y clicks por enlace. Cubre FR-31, FR-33 y FR-34.

Done when: test Playwright con MSW recorre el asistente hasta lanzar una campaña con A/B y ve la página de resultados con los contadores del mock.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Flujo UI de varios pasos; estándar.
- **Dependencies**: F4.1.T5
- **Files**:
  - `apps/admin-web/src/app/[locale]/(console)/campaigns/page.tsx`
  - `apps/admin-web/src/app/[locale]/(console)/campaigns/new/`
  - `apps/admin-web/src/app/[locale]/(console)/campaigns/[id]/`

### F4.6.T4 — Pantalla de dominios de envío y remitentes

Ruta `(console)/campaigns/domains/`: alta de dominio, tabla de registros DNS a crear con botón de copiar, verificación con estado por registro (SPF, DKIM, DMARC), alta de remitentes solo sobre dominios verificados. Cubre FR-36.

Done when: test Playwright con MSW: un dominio sin DKIM muestra el registro faltante y deshabilita "crear remitente"; tras verificar, se habilita.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Pantalla CRUD simple.
- **Dependencies**: F4.6.T3
- **Files**:
  - `apps/admin-web/src/app/[locale]/(console)/campaigns/domains/`

### F4.6.T5 — Centro de preferencias público

Ruta pública `(public)/preferences/[token]` (fuera del layout autenticado): muestra los canales email, SMS y push con toggles y un botón "darme de baja de todo", y envía `POST /t/pref/{token}` al tracker. Página liviana, sin cookies de sesión, en el idioma del `Accept-Language` (es/pt/en) y WCAG 2.2 AA (NFR-15). Token inválido → mensaje de enlace vencido. Cubre FR-35.

Done when: test Playwright con MSW desactiva email y verifica el POST con `{channels:{email:false,...}}`; axe sin violaciones.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Página pública simple con requisitos de accesibilidad.
- **Dependencies**: F4.1.T5
- **Files**:
  - `apps/admin-web/src/app/[locale]/(public)/preferences/`

### F4.6.T6 — Navegación y traducciones de email y campañas

Crear `src/nav/email.ts` con las entradas Email, Campañas y Dominios (con permisos requeridos) según el registro de C11, y completar `messages/{es,pt,en}/email.json` con todas las claves `email.*` y `campaigns.*` que usan las pantallas de F4.6.T1–T5 (extraer las claves del código; no dejar claves sin traducir). Correr `scripts/codegen/nav.mjs`. Cubre FR-5.

Done when: el chequeo de claves faltantes de next-intl (script de F0.7) pasa para los tres idiomas y la navegación muestra las tres entradas.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 1.5h
- **Reason**: Traducciones y registro mecánico.
- **Dependencies**: F4.6.T2, F4.6.T4, F4.6.T5
- **Files**:
  - `apps/admin-web/src/nav/email.ts`
  - `apps/admin-web/messages/es/email.json`
  - `apps/admin-web/messages/pt/email.json`
  - `apps/admin-web/messages/en/email.json`

## F4.7 — Package: wiring, bench y e2e F4

### F4.7.T1 — Gate F4: e2e de campaña enviada, abierta y clickeada

Cierre de fase. Con toda la plataforma levantada por Compose, test en `tests/e2e/email/`: el tenant demo verifica un dominio contra DNS simulado, crea remitente, plantilla con personalización y un enlace, y campaña a un segmento de 10 contactos, uno de ellos con opt-in = 2. Se lanza y se verifica: 9 emails en Mailpit (API HTTP) con nombre personalizado, headers List-Unsubscribe y DKIM válido; 1 excluido por consentimiento. Luego abre el pixel y clickea el enlace de un email, y el response summary muestra 1 apertura y 1 click en menos de 10 s (FR-34). El one-click POST deja el opt-in email = 2 (FR-35). Un External Event `order_shipped` envía el transaccional en < 30 s (FR-37). Incluye un escenario Playwright del editor y la vista previa en admin-web. Cubre FR-27 a FR-37 de punta a punta.

Done when: `pnpm test:e2e --filter email` pasa contra `docker compose up` limpio.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: e2e largo pero sobre servicios ya probados.
- **Dependencies**: F4.2.T6, F4.3.T8, F4.4.T5, F4.4.T6, F4.4.T7, F4.5.T8, F4.6.T6, F4.7.T2, F4.7.T3, F4.7.T4
- **Files**:
  - `tests/e2e/email/`

### F4.7.T2 — Compose y gateway de los servicios de email

Crear `deploy/compose/services/{content,campaigns,dispatcher,tracker}.yml` (build, env, healthcheck, límites de memoria, perfil `core`), incluirlos en `deploy/compose/docker-compose.yml` y crear `deploy/traefik/dynamic/email.yml`: `/admin/v1/content`, `/admin/v1/campaigns` y `/api/v3/email` a su servicio; `/t/*` a tracker con rate limit alto. Dispatcher y las rutas `/internal/v1` no se exponen en el gateway. Agregar roles y schemas de Postgres `content`, `campaigns` y `dispatcher` al init de `deploy/postgres`.

Done when: `docker compose up -d` deja los cuatro servicios healthy y `curl -I http://localhost/t/o/invalid` responde 404 desde tracker.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 2h
- **Reason**: Configuración declarativa.
- **Dependencies**: F4.2.T6, F4.3.T8, F4.4.T6, F4.5.T8
- **Files**:
  - `deploy/compose/services/content.yml`
  - `deploy/compose/services/campaigns.yml`
  - `deploy/compose/services/dispatcher.yml`
  - `deploy/compose/services/tracker.yml`
  - `deploy/compose/docker-compose.yml`
  - `deploy/traefik/dynamic/email.yml`
  - `deploy/postgres/init/40-email-schemas.sql`

### F4.7.T3 — Bench de tracker (NFR-4)

Script `scripts/bench/tracker/` con `vegeta` o `k6`: genera 10.000 tokens válidos con `tracktoken` y siembra sus `link:*`, dispara 1.000 req/s mezclando pixel (70%) y click (30%) durante 60 s contra Compose, y reporta p50, p99 y la tasa de error. Falla si p99 ≥ 20 ms o hay errores. Documentar en `README.md` cómo correrlo. Cubre NFR-4.

Done when: `go run ./scripts/bench/tracker` corre y deja un reporte con p99 < 20 ms en el host de referencia.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Script de carga con umbral.
- **Dependencies**: F4.7.T2
- **Files**:
  - `scripts/bench/tracker/`

### F4.7.T4 — Bench de dispatcher (NFR-6)

Script `scripts/bench/dispatcher/`: siembra 20.000 contactos, publica 20.000 `messages.send.requested` hacia Mailpit con throttling de tenant alto y mide throughput sostenido (emails/s aceptados por el MTA) y duplicados (debe ser 0). Falla si el sostenido < 200 emails/s. Cubre NFR-6 y NFR-11.

Done when: `go run ./scripts/bench/dispatcher` corre y reporta ≥ 200 emails/s y 0 duplicados.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Script de carga con umbral.
- **Dependencies**: F4.7.T2
- **Files**:
  - `scripts/bench/dispatcher/`
