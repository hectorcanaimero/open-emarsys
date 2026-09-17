---
type: spec
project_id: open-emarsys
phase: 2
version: 0.1
depends_on:
  - docs/arch/001-open-emarsys.md
  - docs/prd/001-open-emarsys.md
consumed_by:
  - orch-atomizer
generated_by: orch-spec
generated_at: 2026-09-17
title: Comportamiento en vivo
---

# F2 — Comportamiento en vivo

Milestone M2 del PRD (FR-17 a FR-21, NFR-3). El web-sdk en la tienda demo manda eventos al collector (Go). El collector deduplica, filtra bots, resuelve identidad y publica en NATS (stream `BEHAVIOR`). El sink los escribe en ClickHouse y core muestra la timeline del contacto. Arquitectura: `docs/arch/001-open-emarsys.md`, secciones *Comportamiento*, *ClickHouse*, C1, C2, C4, C10 y C11.

## F2.1 — Package: contracts comportamiento

### F2.1.T1 — Esquemas de eventos de comportamiento y formato de tenant key

Escribir los JSON Schema (draft 2020-12) de los eventos `behavior.tracked`, `external_event.triggered`, `orders.created` e `identity.linked`, siguiendo la tabla de C1 y el envelope `contracts/events/envelope.schema.json` de F0.3. `data` de cada evento extiende el envelope con `$ref`. En `behavior.tracked`, `kind` es un enum (`page_view`, `product_view`, `search`, `cart`, `purchase`, `custom`), `event_id` es obligatorio (dedupe FR-21) y `anonymous_id` es obligatorio. Agregar un ejemplo válido por evento en `contracts/events/examples/`.

Además, escribir `contracts/dsl/tenant-key.md`: la clave pública del SDK (C10 `tenant_key`) es `base64url(tenant_id) + "." + base64url(HMAC-SHA256(k_sdk, tenant_id))[:16]`, con `k_sdk = HKDF(master_key, "oe-sdk-key")`. Es stateless: el collector la verifica sin consultar core, y core la calcula para el snippet. Incluir dos vectores de prueba (tenant_id → tenant_key con una master key de ejemplo). Cubre FR-17, FR-19, FR-20, FR-21.

Done when: la validación de contratos de CI (`pnpm turbo run validate --filter=contracts` o el comando que dejó F0.3) pasa con los 4 esquemas nuevos y sus ejemplos, y un ejemplo con `kind` inválido falla.

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Diseño de contratos compartidos por Go, TS y el SDK, más un esquema de clave con impacto de seguridad.
- **Dependencies**: F1.6.T1
- **Files**:
  - `contracts/events/behavior.tracked.schema.json`
  - `contracts/events/external_event.triggered.schema.json`
  - `contracts/events/orders.created.schema.json`
  - `contracts/events/identity.linked.schema.json`
  - `contracts/events/examples/behavior.tracked.json`
  - `contracts/events/examples/external_event.triggered.json`
  - `contracts/events/examples/orders.created.json`
  - `contracts/events/examples/identity.linked.json`
  - `contracts/dsl/tenant-key.md`

### F2.1.T2 — OpenAPI de collect, External Events, órdenes y endpoints internos

Escribir los contratos HTTP de F2 según C2, C3, C4 y C10:
- `contracts/openapi/collector.yaml`: `POST /c/v1/collect` (body de C10: `tenant_key`, `anonymous_id`, `events[]` con `event_id`, `kind`, `occurred_at` y campos por kind) → `202` con `{accepted, rejected[{index, code}]}`; y las rutas públicas del collector con envelope `replyCode`: `POST /api/v3/event/{id}/trigger` (`key_id`, `external_id`, `data`), `POST /api/v3/event/{id}/trigger-multiple` (hasta 1.000 contactos) y `POST /api/v3/orders`.
- `contracts/openapi/public-v3.yaml`: sección de core `GET/POST /api/v3/event` (definiciones de External Events).
- `contracts/openapi/admin-v1/events.yaml`: CRUD de External Events, `GET /admin/v1/events/sdk-snippet` (devuelve `tenant_key` y el snippet de C10) y `GET /admin/v1/contacts/{id}/timeline?cursor&limit` (items `{event_id, type, occurred_at, url, item_ids, value, currency, props, source: behavior|external|order}`).
- `contracts/openapi/internal/core-behavior.yaml` (C4): `POST /internal/v1/contacts/resolve` (`{tenant_id, key_id, key_value}` → `{contact_id|null}`) y `GET /internal/v1/external-events/{id}?tenant_id=` → `{id, name, payload_schema}`.

Regenerar los tipos TS con el codegen de F0.3 y commitear lo generado. Cubre FR-17, FR-19, FR-20.

Done when: el lint de OpenAPI de CI pasa para los 4 archivos y `pnpm --filter ts-contracts build` compila con los tipos nuevos.

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Contratos de los que dependen cuatro paquetes en paralelo; un error acá se multiplica.
- **Dependencies**: F2.1.T1
- **Files**:
  - `contracts/openapi/collector.yaml`
  - `contracts/openapi/public-v3.yaml`
  - `contracts/openapi/admin-v1/events.yaml`
  - `contracts/openapi/internal/core-behavior.yaml`
  - `packages/ts-contracts/src/generated/collector.ts`
  - `packages/ts-contracts/src/generated/events.ts`
  - `packages/ts-contracts/src/generated/core-behavior.ts`

## F2.2 — Package: clickhouse y sink

### F2.2.T1 — Migraciones ClickHouse de comportamiento

Crear las migraciones del rango F2 (C11: 0200–0299) con las tablas exactas de la sección *ClickHouse* del arch: `events` (`ReplacingMergeTree(received_at)`, `PARTITION BY toYYYYMM(occurred_at)`, `ORDER BY (tenant_id, type, occurred_at, event_id)`, proyección por `contact_id`), `orders` (con `items Nested`), `contacts_replica` (`ReplacingMergeTree(version)`), `message_events` y `program_events`. Las dos últimas se crean ahora para que F4 y F5 solo agreguen consumidores. Usar el runner de migraciones que dejó F0.2. Cubre FR-17, FR-20 y la base de NFR-3.

Done when: `make clickhouse-migrate` (o el runner de F0.2) aplica las 5 migraciones sobre un ClickHouse limpio, las aplica de nuevo sin error (idempotentes con `IF NOT EXISTS`), y `DESCRIBE oe.events` muestra las columnas del arch.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: DDL que ya está especificado en el arch; nivel estándar alcanza.
- **Dependencies**: F2.1.T1
- **Files**:
  - `deploy/clickhouse/migrations/0200_events.sql`
  - `deploy/clickhouse/migrations/0201_orders.sql`
  - `deploy/clickhouse/migrations/0202_contacts_replica.sql`
  - `deploy/clickhouse/migrations/0203_message_events.sql`
  - `deploy/clickhouse/migrations/0204_program_events.sql`

### F2.2.T2 — Sink: framework de lotes y writers de eventos y órdenes

Implementar `services/collector/cmd/sink`. Consume JetStream con consumidores durables `sink-behavior` (subjects `oe.behavior.>` y `oe.external_event.>`) y `sink-orders` (`oe.orders.>`), usando el consume de `libs/go/oe` (C1). Framework de lotes: acumula hasta 5.000 filas o 1 s, inserta con `clickhouse-go` batch y hace ack **solo después** del insert exitoso; si el insert falla hace nak con backoff, así no se pierden eventos (NFR-11). `behavior.tracked` y `external_event.triggered` van a `oe.events` (`type` = kind, o `external:<name>`; `props` = payload); `orders.created` va a `oe.orders` y además a `oe.events` como `purchase` cuando no vino ya del SDK con el mismo `event_id`. Expone métricas OTel: filas escritas, lag del consumidor y duración del lote. Cubre FR-17, FR-19, FR-20, NFR-3, NFR-11.

Done when: `go test ./services/collector/internal/sink/...` pasa, incluido un test de integración (testcontainers NATS + ClickHouse) que publica 10.000 eventos, reinicia el sink a mitad y verifica exactamente 10.000 filas después de `OPTIMIZE ... FINAL`.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Consumo con ack después de persistir; hay que ser cuidadoso, pero el patrón es conocido.
- **Dependencies**: F2.2.T1, F2.3.T1
- **Files**:
  - `services/collector/cmd/sink/main.go`
  - `services/collector/internal/sink/batch.go`
  - `services/collector/internal/sink/events.go`
  - `services/collector/internal/sink/orders.go`
  - `services/collector/internal/sink/sink_test.go`

### F2.2.T3 — Sink: réplica de contactos y anonimización GDPR

Agregar el consumidor durable `sink-contacts` (`oe.contacts.>`) al sink de F2.2.T2. `contacts.upserted` escribe en `oe.contacts_replica` con `version` del evento, `fields` como `Map(String,String)` indexado por field ID y `lists`. `contacts.deleted` escribe una fila con `deleted=1` y versión mayor, y lanza la anonimización: `ALTER TABLE oe.events UPDATE anonymous_id='', url='', props='{}' WHERE tenant_id=? AND contact_id=?` (mutación asíncrona) y lo mismo en `orders` para los campos personales. Registrar el consumidor en `cmd/sink/main.go`. Cubre la réplica de D4 y NFR-10 (parte FR-15 en ClickHouse).

Done when: un test de integración publica un upsert v1, un upsert v2 y un delete, y verifica que `SELECT ... FROM contacts_replica FINAL` devuelve la versión con `deleted=1` y que los eventos del contacto quedan con `props='{}'` después de esperar la mutación.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Consumidor adicional sobre un framework ya hecho; nivel estándar.
- **Dependencies**: F2.2.T2
- **Files**:
  - `services/collector/internal/sink/contacts.go`
  - `services/collector/internal/sink/gdpr.go`
  - `services/collector/internal/sink/contacts_test.go`
  - `services/collector/cmd/sink/main.go`

## F2.3 — Package: collector

### F2.3.T1 — Scaffold del módulo Go collector

Crear el módulo Go `services/collector` (un `go.mod`, dos binarios según el layout del arch: `cmd/collector` y `cmd/sink`), agregarlo a `go.work` y escribir un Dockerfile multi-stage que compile los dos binarios en una imagen distroless. `cmd/collector/main.go` levanta un servidor HTTP con `/healthz`, config por env con el loader de `libs/go/oe`, logger JSON y OTel. `internal/config` define `COLLECTOR_ADDR`, `NATS_URL`, `REDIS_URL`, `CORE_INTERNAL_URL`, `OE_MASTER_KEY` y `CLICKHOUSE_DSN`.

Done when: `go build ./services/collector/...` y `docker build -f services/collector/Dockerfile .` terminan bien, y `curl localhost:$PORT/healthz` responde 200 con el binario corriendo.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 1.5h
- **Reason**: Boilerplate de scaffold siguiendo patrones de libs/go/oe.
- **Dependencies**: F1.6.T1
- **Files**:
  - `services/collector/go.mod`
  - `services/collector/go.sum`
  - `go.work`
  - `services/collector/Dockerfile`
  - `services/collector/cmd/collector/main.go`
  - `services/collector/internal/config/config.go`

### F2.3.T2 — Endpoint de collect con verificación de tenant key y publicación

Implementar `POST /c/v1/collect` según `contracts/openapi/collector.yaml` (C10). Pipeline en `internal/collect/collect.go`, con etapas como funciones en orden fijo: verificar `tenant_key` (formato y HMAC de `contracts/dsl/tenant-key.md`, comparación en tiempo constante; si es inválida → 401 sin detalle), validar cada evento contra `behavior.tracked` (lote máximo 100 eventos y 64 KB; los inválidos van a `rejected[]` sin tumbar el lote), completar `received_at`, y publicar cada evento con el publisher de `libs/go/oe` en `oe.behavior.tracked.<tenant_id>` con `Nats-Msg-Id = event_id` (C1). Dejar dos hooks explícitos en el pipeline (`dedupe` y `identity`) como funciones no-op que F2.3.T5 reemplaza. `internal/collect/server.go` registra rutas y CORS (cualquier origen, sin cookies). Responde 202. Cubre FR-17, NFR-3, NFR-8 (un tenant no puede publicar como otro).

Done when: `go test ./services/collector/internal/collect/...` pasa con casos de key válida, key forjada para otro tenant (401), lote con eventos mixtos válidos e inválidos, y publicación verificada contra un NATS de testcontainers.

- **Model**: claude/claude-opus-5
- **Estimate**: 4h
- **Reason**: Borde público sin autenticación de usuario; la verificación de clave es sensible a seguridad.
- **Dependencies**: F2.3.T1, F2.1.T2
- **Files**:
  - `services/collector/internal/collect/server.go`
  - `services/collector/internal/collect/collect.go`
  - `services/collector/internal/collect/tenantkey.go`
  - `services/collector/internal/collect/collect_test.go`
  - `services/collector/cmd/collector/main.go`

### F2.3.T3 — Deduplicación y filtro de bots

Implementar dos funciones puras con sus dependencias inyectadas, que F2.3.T5 conecta al pipeline:
- `Dedupe(ctx, tenantID, eventID) (dup bool, err error)`: `SET evt:<tenant>:<event_id> 1 NX EX 86400` en Redis (sección *Redis* del arch). Si Redis no responde, deja pasar el evento (JetStream deduplica 2 min por `Nats-Msg-Id`) y cuenta una métrica.
- `IsBot(userAgent string) bool`: lista embebida de patrones de crawlers conocidos (Googlebot, Bingbot, AhrefsBot, headless Chrome, etc.; usar un `//go:embed` de `bots.txt` con regex combinada y compilada una sola vez).

Cubre FR-21.

Done when: `go test ./services/collector/internal/collect/ -run 'Dedupe|Bot'` pasa: el mismo `event_id` dos veces da `dup=true` la segunda (miniredis), Redis caído no bloquea, y 10 UAs de bots conocidos dan true y 5 de navegadores reales dan false.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Lógica acotada con tests claros.
- **Dependencies**: F2.3.T2
- **Files**:
  - `services/collector/internal/collect/dedupe.go`
  - `services/collector/internal/collect/dedupe_test.go`
  - `services/collector/internal/collect/bots.go`
  - `services/collector/internal/collect/bots.txt`
  - `services/collector/internal/collect/bots_test.go`

### F2.3.T4 — Resolución de identidad anónimo → contacto

Implementar `internal/identity`. `Resolver.Resolve(ctx, tenantID, anonymousID, identify *Identify) (contactID *uuid, err)`:
1. Si el lote trae un evento `identify` (email o external_id), llama a core `POST /internal/v1/contacts/resolve` (`contracts/openapi/internal/core-behavior.yaml`) con token de servicio. Si encuentra el contacto, guarda `idl:<tenant>:<anonymous_id> = contact_id` en Redis (TTL 400 días) y publica `identity.linked` (C1) solo la primera vez que se forma ese par.
2. Si no hay identify, lee `idl:<tenant>:<anonymous_id>` de Redis.

Los eventos previos a la identificación no se reescriben: la timeline los une por `identity_links` (F2.5.T2). Caché local LRU de 10 s para resoluciones negativas, para no martillar a core. Cubre FR-18.

Done when: `go test ./services/collector/internal/identity/...` pasa con un core falso (httptest): identify nuevo publica `identity.linked` una vez, un segundo identify igual no republica, un evento anónimo posterior resuelve desde Redis, y un core caído devuelve `nil` sin error fatal.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Lógica con caché y efectos laterales, pero con un contrato cerrado.
- **Dependencies**: F2.3.T2
- **Files**:
  - `services/collector/internal/identity/resolver.go`
  - `services/collector/internal/identity/resolver_test.go`

### F2.3.T5 — External Events, órdenes y conexión del pipeline

Conectar `Dedupe`, `IsBot` (F2.3.T3) y `Resolver` (F2.3.T4) al pipeline de `collect.go`: un bot descarta el lote entero con 202 sin publicar, un evento duplicado se omite, y `contact_id` se completa si se resolvió. Implementar las rutas públicas de `contracts/openapi/collector.yaml` con JWT `typ=client` y scope `events:write` (middleware de `libs/go/oe`), envelope `replyCode` (C2) y errores por ítem en `data.errors`:
- `POST /api/v3/event/{id}/trigger`: valida que el External Event exista (core `GET /internal/v1/external-events/{id}`, caché 60 s) y opcionalmente el payload contra su `payload_schema`, resuelve el contacto por `key_id`/`external_id`, y publica `external_event.triggered`.
- `trigger-multiple`: hasta 1.000 contactos, con errores por posición.
- `POST /api/v3/orders`: valida y publica `orders.created`; `event_id` = hash determinista de `tenant_id + order_id` (reenviar la orden no duplica).

Cubre FR-19, FR-20, FR-21, NFR-8.

Done when: `go test ./services/collector/internal/collect/...` pasa, con tests de trigger con evento inexistente (`replyCode` ≠ 0), trigger-multiple con 2 contactos inexistentes de 10, orden reenviada que publica con el mismo `Nats-Msg-Id`, token de otro tenant rechazado, y lote de un UA bot que no publica nada.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Integración de piezas ya probadas más endpoints con contrato fijo.
- **Dependencies**: F2.3.T3, F2.3.T4
- **Files**:
  - `services/collector/internal/collect/collect.go`
  - `services/collector/internal/collect/server.go`
  - `services/collector/internal/collect/external.go`
  - `services/collector/internal/collect/external_test.go`
  - `services/collector/internal/collect/orders.go`
  - `services/collector/internal/collect/orders_test.go`

## F2.4 — Package: web-sdk

### F2.4.T1 — Web SDK: cola, cookie anónima y transporte

Crear `packages/web-sdk` (TypeScript, sin dependencias de runtime, build con esbuild a un IIFE `dist/sdk.js`). Implementar el loader de C10: procesa `oe.q` y después reemplaza `window.oe` por el dispatcher real. `init({tenant})` guarda el `tenant_key`. La cookie de primera parte `oe_aid` (UUID v4, 400 días, `SameSite=Lax`, `Secure` en https) se crea si falta. El transporte acumula eventos (cada uno con `event_id` UUID v4 y `occurred_at`) y los envía a `POST /c/v1/collect` cada 2 s, o con `navigator.sendBeacon` en `visibilitychange=hidden` y `pagehide`; si falla, reintenta una vez y descarta. Cubre FR-17.

Done when: `pnpm --filter web-sdk test` (vitest + jsdom) pasa con: cola previa a la carga procesada en orden, cookie persistente entre inits, flush por tiempo y por `visibilitychange`, y `pnpm --filter web-sdk build` genera `dist/sdk.js`.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: JS de navegador con detalles de ciclo de vida de página; nivel estándar.
- **Dependencies**: F2.1.T2
- **Files**:
  - `packages/web-sdk/package.json`
  - `packages/web-sdk/tsconfig.json`
  - `packages/web-sdk/build.mjs`
  - `packages/web-sdk/src/index.ts`
  - `packages/web-sdk/src/queue.ts`
  - `packages/web-sdk/src/cookie.ts`
  - `packages/web-sdk/src/transport.ts`
  - `packages/web-sdk/test/transport.test.ts`

### F2.4.T2 — Web SDK: comandos de tracking y presupuesto de tamaño

Implementar los comandos de C10 sobre el transporte de F2.4.T1: `identify({email|external_id})`, `page()` (url, referrer, title), `view(item_id)`, `search(term)`, `cart([{item_id, qty, price}])`, `purchase({order_id, items, total, currency})` y `track(name, props)`. Cada uno arma el evento con la forma exacta de `behavior.tracked` (usar los tipos de `packages/ts-contracts`, solo en tiempo de compilación). `purchase` usa `event_id` = `order_id` hasheado igual que el collector, para que SDK + API de órdenes no dupliquen (FR-21). Comando desconocido → `console.warn` y se ignora. Agregar un test que falla si `dist/sdk.js` gzip supera 10 KB. Cubre FR-17, FR-18, FR-21.

Done when: `pnpm --filter web-sdk test` pasa con un test por comando que valida el payload contra `contracts/events/behavior.tracked.schema.json` (ajv) y el test de tamaño.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Mapeo directo a un esquema existente, con tests.
- **Dependencies**: F2.4.T1
- **Files**:
  - `packages/web-sdk/src/commands.ts`
  - `packages/web-sdk/test/commands.test.ts`
  - `packages/web-sdk/test/size.test.ts`

## F2.5 — Package: core events y timeline

### F2.5.T1 — Módulo events-registry en core

Crear el módulo NestJS `events-registry` en `services/core/src/modules/events-registry/`, con modelo Prisma en `prisma/schema/events.prisma`: tabla `external_events(tenant_id, id int, name, payload_schema jsonb)` con id secuencial por tenant, único `(tenant_id, name)` y RLS con la extensión de `packages/ts-common` (sección *PostgreSQL* del arch). Endpoints según `contracts/openapi/admin-v1/events.yaml` y la sección `/event` de `public-v3.yaml`: CRUD admin (permiso `events:edit`), `GET/POST /api/v3/event` con envelope, `GET /admin/v1/events/sdk-snippet` (calcula `tenant_key` con `contracts/dsl/tenant-key.md`, usando los vectores de prueba en el test) e interno `GET /internal/v1/external-events/{id}` (C4, token de servicio). Auditar escrituras (FR-6). No registrar el módulo en `app.module.ts`: lo hace F2.8.T2. Cubre FR-19, NFR-8.

Done when: `pnpm --filter core test -- events-registry` pasa con CRUD, nombre duplicado → 409, `tenant_key` igual a los vectores del contrato, y un test de acceso cruzado donde el tenant B no ve eventos del A.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: CRUD NestJS estándar con patrones ya establecidos en F0/F1.
- **Dependencies**: F2.1.T2
- **Files**:
  - `services/core/src/modules/events-registry/`
  - `services/core/prisma/schema/events.prisma`
  - `services/core/prisma/migrations/20260917020100_events_registry/migration.sql`

### F2.5.T3 — Módulo identity-links en core

Crear el módulo `identity-links`. El modelo Prisma `identity_links(tenant_id, anonymous_id, contact_id, linked_at)` (definido en la sección *PostgreSQL*, schema `contacts`) va en su propio archivo `prisma/schema/identity-links.prisma` (C11), con PK `(tenant_id, anonymous_id)` y RLS. El consumidor NATS durable `core-identity-links` (`oe.identity.linked.*`) hace upsert idempotente. Endpoint interno `POST /internal/v1/contacts/resolve` según `contracts/openapi/internal/core-behavior.yaml`: busca por `key_id` 3 (email normalizado), por `external_id` o por un campo custom único (`unique_values` de F1), y devuelve `contact_id` o null. No registrar el módulo en `app.module.ts`. Cubre FR-18, NFR-8.

Done when: `pnpm --filter core test -- identity-links` pasa con resolve por email con mayúsculas y espacios, por external_id y por campo único, el consumidor procesando dos veces el mismo evento sin duplicar, y resolve con `tenant_id` de otro tenant devolviendo null.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Módulo acotado con consumidor y endpoint interno.
- **Dependencies**: F2.5.T1
- **Files**:
  - `services/core/src/modules/identity-links/`
  - `services/core/prisma/schema/identity-links.prisma`
  - `services/core/prisma/migrations/20260917020200_identity_links/migration.sql`

### F2.5.T2 — Módulo timeline en core (lectura ClickHouse)

Crear el módulo `timeline` (decisión D12). Endpoint `GET /admin/v1/contacts/{id}/timeline?cursor&limit` (permiso `contacts:view`), según `contracts/openapi/admin-v1/events.yaml`. Lee ClickHouse con `@clickhouse/client` y un usuario de solo lectura, con consultas parametrizadas: eventos donde `tenant_id = ? AND (contact_id = ? OR anonymous_id IN (anónimos del contacto en identity_links))`, más órdenes, ordenados por `occurred_at DESC`. Cursor = `(occurred_at, event_id)` codificado; `limit` por defecto 50 y máximo 200. El `tenant_id` sale siempre del JWT, nunca del request. Cubre FR-10 (timeline), FR-17, FR-18, NFR-8.

Done when: `pnpm --filter core test -- timeline` pasa con un test de integración (ClickHouse de testcontainers con las migraciones 02xx) que verifica: eventos anónimos previos al link en la timeline, paginación sin huecos ni repetidos sobre 120 eventos, y cero eventos para un contacto de otro tenant.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Consulta de lectura con paginación por cursor; estándar.
- **Dependencies**: F2.5.T3, F2.2.T1
- **Files**:
  - `services/core/src/modules/timeline/`
  - `services/core/package.json`

## F2.6 — Package: demo-shop y seed

### F2.6.T1 — Tienda demo con web-sdk

Crear `apps/demo-shop` (Next.js 15 App Router + Tailwind): tienda ficticia de calzado y ropa (asunción A9), con `data/catalog.json` (200 productos con `item_id`, título, URL, imagen placeholder SVG local, precio, categoría, marca, disponibilidad). Páginas: home, categoría, producto, búsqueda, carrito (estado en localStorage), checkout ficticio y login falso por email. Integra el web-sdk con el snippet de C10 (tenant key por env `NEXT_PUBLIC_OE_TENANT_KEY`, host por `NEXT_PUBLIC_OE_HOST`) y llama `page`, `view`, `search`, `cart`, `purchase` e `identify` en cada acción. Dockerfile standalone. Cubre FR-17, FR-18 (fuente de datos de A9).

Done when: `pnpm --filter demo-shop build` pasa y un test Playwright local (con el collector interceptado por `page.route`) verifica que ver un producto, agregarlo al carrito y comprar dispara los eventos `product_view`, `cart` y `purchase` con los `item_id` correctos.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: App Next.js de demo sin lógica de negocio compleja.
- **Dependencies**: F2.4.T2
- **Files**:
  - `apps/demo-shop/`

### F2.6.T2 — Generador de seed de comportamiento

Escribir `scripts/seed/behavior/seed.mjs` (Node 22, sin dependencias externas salvo `@clickhouse/client`), parametrizado por `SEED_SCALE` (1 = 100.000 contactos y 10 M eventos, NFR-13) y una semilla aleatoria fija. Contactos vía API pública `/api/v3/contact` en lotes de 1.000, con campos de sistema, país (campo custom) y opt-in. Eventos generados con distribuciones realistas (sesiones con page_view → product_view → cart → purchase con embudo 100/40/8/2 %) usando los `item_id` de `apps/demo-shop/data/catalog.json`, insertados directo en ClickHouse `oe.events` y `oe.orders` por lotes de 100.000 (bypass del collector para cargar en minutos). Un 20 % de contactos tiene eventos anónimos con `identity_links` insertados por el endpoint interno. Idempotente por semilla (IDs deterministas). Cubre NFR-13 y los datos de validación de FR-22 (F3).

Done when: `SEED_SCALE=0.01 node scripts/seed/behavior/seed.mjs` contra la stack local termina y `SELECT count() FROM oe.events` da 100.000 ± 1 %; correrlo dos veces no duplica filas después de `OPTIMIZE FINAL`.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Script de generación de datos con distribuciones; estándar.
- **Dependencies**: F2.6.T1, F2.1.T2
- **Files**:
  - `scripts/seed/behavior/seed.mjs`
  - `scripts/seed/behavior/distributions.mjs`
  - `scripts/seed/behavior/README.md`

### F2.6.T3 — Benchmark de ingesta NFR-3

Escribir un escenario k6 en `scripts/bench/collector/collect.js` que sostiene 2.000 eventos/s (lotes de 10 eventos a 200 req/s) durante 10 minutos contra `/c/v1/collect`, con tenant keys válidas de 5 tenants y un 1 % de `event_id` repetidos. Thresholds: `http_req_duration p(99) < 50 ms` y `http_req_failed < 0.1 %`. Incluir `verify.sql`, que compara los eventos aceptados (métrica custom de k6 exportada a JSON) con `count()` en ClickHouse, para demostrar cero pérdida. Documentar en `README.md` cómo correrlo y el host de referencia (8 vCPU/16 GB). Cubre NFR-3.

Done when: `k6 inspect scripts/bench/collector/collect.js` valida el script y la corrida corta `k6 run -e DURATION=30s` contra la stack local termina con thresholds evaluados (el resultado completo se registra en el gate F2.8.T1).

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 2h
- **Reason**: Script de carga con un patrón estándar de k6.
- **Dependencies**: F2.1.T2
- **Files**:
  - `scripts/bench/collector/collect.js`
  - `scripts/bench/collector/verify.sql`
  - `scripts/bench/collector/README.md`

## F2.7 — Package: admin-web comportamiento

### F2.7.T1 — Gestor de External Events y snippet del SDK

En admin-web, crear la feature `events` (C11): listado, alta, edición y borrado de External Events con nombre y `payload_schema` opcional (editor JSON con validación), y una página "Instalar tracking" que muestra el snippet de `GET /admin/v1/events/sdk-snippet` con botón de copiar y ejemplos de cada comando de C10. Clientes tipados de `packages/ts-contracts`. Entrada de navegación en `src/nav/events.ts` visible con permiso `events:view`, y textos en es/pt/en. Formularios con react-hook-form + zod, componentes shadcn, accesibles con teclado (NFR-15). Cubre FR-19, FR-17 (instalación), FR-5, NFR-16.

Done when: `pnpm --filter admin-web test -- events` (Testing Library, API mockeada con msw) pasa con crear un evento, error 409 visible por nombre duplicado y copiar el snippet; `pnpm --filter admin-web build` pasa sin claves de i18n faltantes.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Pantallas CRUD con patrones ya establecidos en F0/F1.
- **Dependencies**: F2.1.T2
- **Files**:
  - `apps/admin-web/src/app/[locale]/(console)/events/`
  - `apps/admin-web/src/nav/events.ts`
  - `apps/admin-web/messages/es/events.json`
  - `apps/admin-web/messages/pt/events.json`
  - `apps/admin-web/messages/en/events.json`

### F2.7.T2 — Timeline en la ficha del contacto

Crear el componente `contact-timeline`: lista virtualizada con scroll infinito sobre `GET /admin/v1/contacts/{id}/timeline` (cursor), con ícono y descripción por tipo (vista de página, vista de producto con item, búsqueda, carrito con ítems, compra con total y moneda formateados por locale, evento externo con payload expandible, orden), fecha relativa con tooltip absoluto en la zona horaria del tenant, filtros por tipo y estado vacío. Insertarlo como pestaña "Actividad" en la ficha del contacto que creó F1.5. Textos en `messages/*/timeline.json`. Cubre FR-10, FR-17, FR-18, NFR-15, NFR-16.

Done when: `pnpm --filter admin-web test -- contact-timeline` pasa con render de cada tipo de evento, carga de la segunda página al llegar al final y filtro por tipo; axe sin violaciones en el test del componente.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Componente de UI con paginación; nivel estándar.
- **Dependencies**: F2.1.T2
- **Files**:
  - `apps/admin-web/src/components/contact-timeline/`
  - `apps/admin-web/src/app/[locale]/(console)/contacts/[id]/page.tsx`
  - `apps/admin-web/messages/es/timeline.json`
  - `apps/admin-web/messages/pt/timeline.json`
  - `apps/admin-web/messages/en/timeline.json`

## F2.8 — Package: wiring y e2e F2

### F2.8.T1 — Cierre de fase F2: e2e de comportamiento y NFR-3

Gate de la fase. Con la stack completa (`docker compose --profile core --profile data up`), escribir y correr los e2e en `tests/e2e/behavior/`:
1. **FR-17:** en demo-shop, identificarse, agregar un producto al carrito y verificar en la ficha del contacto de admin-web (Playwright) que el evento `cart` aparece en menos de 5 s.
2. **FR-18:** navegar anónimo, identificarse y ver en la timeline las vistas previas.
3. **FR-19:** crear un External Event por admin-web, dispararlo por API con payload y verlo en la timeline.
4. **FR-20:** cargar una orden por API y verla en la timeline con su total.
5. **FR-21:** reenviar la misma orden y el mismo lote del SDK y verificar conteos sin duplicar; un lote con UA de bot no crea eventos.
6. **NFR-8:** tenant key y token de otro tenant rechazados.

Correr el seed (`SEED_SCALE=1`) y el bench de F2.6.T3 completo, y registrar p99, tasa de error y verificación de pérdida en `tests/e2e/behavior/RESULTS.md`. Cubre FR-17 a FR-21, NFR-3, NFR-8, NFR-13.

Done when: `pnpm --filter e2e test -- behavior` pasa en verde y `RESULTS.md` muestra p99 < 50 ms y cero eventos perdidos a 2.000 eventos/s.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Integración y verificación de punta a punta; estándar, con muchas piezas.
- **Dependencies**: F2.8.T2, F2.6.T2, F2.6.T3, F2.7.T1, F2.7.T2
- **Files**:
  - `tests/e2e/behavior/`

### F2.8.T2 — Wiring de F2: compose, gateway, módulos de core y SDK servido

Conectar todo lo construido en F2 (regla C11):
- `deploy/compose/services/collector.yml` con los servicios `collector` y `sink` (misma imagen, distinto comando, perfil `data`, límites de memoria, healthchecks) incluido desde `deploy/compose/docker-compose.yml`, más la migración ClickHouse 02xx en el job de migraciones.
- `deploy/traefik/dynamic/collector.yml`: enrutar `/c/*`, `/api/v3/event/*/trigger*` y `/api/v3/orders` a collector, y `/api/v3/event` más `/admin/v1/events` y `/admin/v1/contacts/*/timeline` a core; rate limit de `/c/*` por IP.
- Registrar `EventsRegistryModule`, `IdentityLinksModule` y `TimelineModule` en `services/core/src/app.module.ts`.
- Servir `GET /c/sdk.js` desde collector (`internal/collect/sdk.go`: archivo montado por volumen desde el build de `packages/web-sdk`, con `Cache-Control: public, max-age=300`).
- Servicio `demo-shop` en `deploy/compose/services/demo-shop.yml`.

Done when: `docker compose --profile core --profile data up -d` levanta todo healthy, `curl -s localhost/c/sdk.js | head -c 50` devuelve JS, `curl -X POST localhost/c/v1/collect` con una tenant key del seed da 202, y la demo-shop carga en el navegador enviando eventos.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Configuración de integración con varios archivos compartidos; estándar.
- **Dependencies**: F2.2.T3, F2.3.T5, F2.4.T2, F2.5.T2, F2.6.T1
- **Files**:
  - `deploy/compose/services/collector.yml`
  - `deploy/compose/services/demo-shop.yml`
  - `deploy/compose/docker-compose.yml`
  - `deploy/traefik/dynamic/collector.yml`
  - `services/core/src/app.module.ts`
  - `services/collector/internal/collect/sdk.go`
  - `services/collector/internal/collect/server.go`
