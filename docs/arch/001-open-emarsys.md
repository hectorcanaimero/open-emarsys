---
type: arch
project_id: open-emarsys
version: 0.1
depends_on:
  - docs/prd/001-open-emarsys.md
generated_by: orch-arch
generated_at: 2026-09-17
title: open-emarsys — architecture
---

# open-emarsys — architecture

## Context

El repositorio está vacío salvo el scaffold de orch, el Rx de Emarsys (`docs/rx/emarsys.md`) y el PRD. No hay código previo que respetar; las restricciones son las del PRD (NFR-1, NFR-2) y las asunciones A1–A11. Este documento fija la topología de servicios, los contratos compartidos y el orden de construcción F0–F10. Cada fase corresponde al milestone M<n> del PRD.

Principio rector: **plano de control** (configuración, CRUD, consola; NestJS) separado del **plano de datos** (por evento o por contacto, alto volumen; Go), con **Python** solo para entrenamiento e IA generativa. Los servicios se comunican por eventos en NATS JetStream; lo síncrono es REST (y gRPC solo hacia `segments` y `scorer`).

## Components

### Layout del monorepo

```
apps/
  admin-web/          Next.js 15 — consola (marketer, admin, operador)
  demo-shop/          Next.js 15 — tienda ficticia que genera tráfico real (A9)
  demo-app/           Flutter — app demo para push/inbox (F7)
services/
  core/               NestJS — identity, contacts, events-registry, catalog, devices, inbox
  content/            NestJS — plantillas, bloques, assets, compilación MJML, web pieces, wallet
  campaigns/          NestJS — campañas, agenda, A/B, sender domains
  automation/         NestJS — definición y versionado de programas, stats
  analytics/          NestJS — reportes, atribución, dashboard, RFM
  loyalty/            NestJS — niveles, puntos, recompensas
  connectors/         NestJS — e-commerce, audiencias de Ads, webhooks salientes
  collector/          Go — ingesta de eventos + sinks a ClickHouse (cmd/collector, cmd/sink)
  tracker/            Go — pixel, redirect, baja one-click, webhooks de proveedores
  importer/           Go — import/export CSV, Open Data Parquet
  segments/           Go — definiciones, compilador DSL→SQL, conteo, materialización, gRPC
  dispatcher/         Go — render, envío por canal, throttling, idempotencia
  engine/             Go — worker Temporal que ejecuta programas
  scorer/             Go — gRPC Score/Recommend con modelos ONNX y tablas
  personalize/        Go — endpoints públicos de recomendaciones y web pieces
  ml/                 Python — entrenamiento, registro de modelos, predicciones batch
  genai/              Python — FastAPI, router LLM, generación, NL→segmento, asistente
packages/
  web-sdk/            TypeScript — script de tracking y widgets (<10 KB gz)
  ts-common/          TypeScript — utilidades NestJS compartidas (auth, tenant, envelope, NATS, OTel)
  ts-contracts/       TypeScript — tipos generados de contracts/ y proto/
libs/
  go/oe/              Go — nats, otel, tenant ctx, jwt, envelope HTTP, clickhouse, config
sdk/
  flutter/            Flutter — SDK móvil (F7)
contracts/
  events/             JSON Schema de cada evento del bus
  openapi/            public-v3.yaml (API pública) + admin-v1/*.yaml (API de la consola)
  dsl/                segment.schema.json, program.schema.json, personalization.md
proto/                buf workspace — segments/v1, scorer/v1
deploy/
  compose/            docker-compose.yml raíz + services/<svc>.yml incluidos
  clickhouse/         migraciones SQL numeradas
  nats/ temporal/ traefik/ observability/
scripts/              seed, benchmarks, codegen
tests/e2e/            escenarios de punta a punta (Playwright + Go)
```

### Plataforma y borde

- **gateway (Traefik, solo config).** Único punto de entrada. Enruta por prefijo: `/api/v3/*` a los servicios dueños del recurso, `/admin/v1/*` ídem, `/c/*` a collector, `/t/*` a tracker, `/p/*` a personalize, `/genai/*` a genai. Rate limit por IP y cabecera `X-Tenant`. No valida JWT: cada servicio lo verifica con `libs/go/oe/auth` o `packages/ts-common/auth` contra el JWKS de core.
- **core / identity (NestJS).** Dueño de tenants, usuarios, roles, permisos, sesiones, MFA, API clients y audit log. Emite JWT RS256 para usuarios (`typ=user`) y API clients (`typ=client`), y tokens de servicio (`typ=service`) para llamadas internas. Publica JWKS en `/.well-known/jwks.json`.
- **admin-web (Next.js).** Consola. Habla solo con `/admin/v1` vía gateway, con el JWT del usuario en cookie httpOnly gestionada por route handlers de Next.

### Datos de clientes

- **core / contacts.** Dueño de definiciones de campos, contactos, listas, consentimientos, tablas relacionales y solicitudes GDPR. Publica `contacts.*` y `consent.*`. Consume `messages.unsubscribed` y `messages.bounced` (supresión) y `identity.linked`. Consulta ClickHouse en solo lectura para la timeline.
- **core / events-registry.** Definiciones de External Events (nombre, id, esquema opcional del payload).
- **core / catalog (F6).** Productos. Publica `catalog.*`.
- **core / devices, inbox (F7).** Registro de dispositivos push y mensajes de bandeja.
- **importer (Go).** Jobs de import CSV (streaming, lotes de 1.000 hacia la API interna de core), export (stream NDJSON desde core o consulta a ClickHouse) a MinIO con URL firmada, feed de catálogo programado (F6) y Open Data Parquet (F8). Dueño de la tabla `jobs` en el schema `importer`.

### Comportamiento

- **collector (Go).** `cmd/collector`: recibe lotes del web-sdk, External Events, órdenes y eventos de SDK móvil; valida contra JSON Schema; deduplica con Redis (`SETNX evt:<tenant>:<event_id>`, TTL 24 h); filtra bots; resuelve identidad (cookie anónima → contacto) y publica en NATS. `cmd/sink`: consumidores JetStream que escriben por lotes en ClickHouse (eventos, órdenes, mensajes, réplica de contactos, productos, eventos de programa).
- **web-sdk (TS).** Cola de comandos estilo `oe('track', ...)`, cookie `oe_aid` de primera parte, envío por `sendBeacon` en lotes, widgets de recomendaciones y web pieces (F6/F7).

### Audiencia

- **segments (Go).** Dueño de definiciones de segmentos (Postgres schema `segments`), ejecuciones e historial. Compila el DSL (`contracts/dsl/segment.schema.json`) a SQL de ClickHouse que corre sobre la réplica de contactos + eventos. Materializa miembros en ClickHouse `segment_members`. Expone REST (admin y pública) y gRPC `segments.v1.Segments` (`Count`, `IsMember`, `Materialize`). Programa ejecuciones con un scheduler interno (tabla `schedules` + ticker con lock de Postgres advisory).

### Contenido y canales

- **content (NestJS).** Plantillas (árbol de bloques JSON), bloques compartidos, assets en MinIO, compilación **MJML → HTML** al publicar una versión, validación de sintaxis de personalización. Guarda `content_versions` inmutables con `html`, `text`, `subject`, `preheader` y la lista de variables usadas. En F7 suma web pieces y pases de wallet.
- **campaigns (NestJS).** Campañas, variantes A/B, agenda, lanzamiento, dominios de envío (verificación DNS, llaves DKIM cifradas). Al lanzar: pide a segments `Materialize`, pagina miembros, aplica exclusiones que no dependen del estado en vivo, y publica `messages.send.requested` por contacto. La agenda por zona horaria y la espera del A/B usan BullMQ interno (A3).
- **dispatcher (Go).** Consume `messages.send.requested` (de campaigns y engine). Pipeline por mensaje: idempotencia (tabla `dispatcher.sends` con PK `message_id`) → frecuencia (Redis, F5) → consentimiento y supresión (caché Redis alimentada por `consent.*` y `messages.*`) → carga de `content_version` (caché LRU + REST interno a content) → datos del contacto (REST interno a core, lote) → **render Liquid** (`osteele/liquid`) con contexto `contact`, `event`, `recs` (F6), `loyalty` (F9) → reescritura de enlaces y pixel con tokens de tracking → adaptador del canal (SMTP/SES con DKIM; SMS, push en F7) → publica `messages.sent` o `messages.failed`. Límite de tasa por tenant y por dominio destino con token bucket en Redis. Expone `POST /internal/v1/render` para vistas previas y envíos de prueba: **el único renderizador del sistema es Go**.
- **tracker (Go).** `GET /t/o/{token}` (pixel 1×1), `GET /t/c/{token}` (redirect 302), `POST /t/u/{token}` (List-Unsubscribe-Post), `GET /t/pref/{token}` (redirige al centro de preferencias de admin-web), webhooks de proveedores `POST /t/wh/{provider}` (SES/SNS, Twilio, FCM). Valida tokens, detecta aperturas de máquina (Apple MPP por IP/UA, escáneres por tiempo desde el envío < 2 s), publica `messages.*`.
- **personalize (Go, F6/F7).** `GET /p/v1/recs` y `GET /p/v1/pieces` para el web-sdk; llama a scorer por gRPC; publica impresiones al collector.

### Orquestación

- **automation (NestJS).** Programas y versiones inmutables del grafo (`contracts/dsl/program.schema.json`), validación estructural, activación/pausa/parada, publica `programs.version.published` y `programs.status.changed`. Sirve stats por nodo y recorrido de un contacto leyendo `program_events` en ClickHouse.
- **engine (Go).** Worker de Temporal (namespace `open-emarsys`). `trigger-router`: consumidores NATS que, para cada evento, buscan programas activos cuyo trigger coincide (índice en memoria recargado por `programs.*`) y arrancan un workflow con `WorkflowID = prog:<programId>:<contactId>:<entryKey>` (la regla de reingreso define `entryKey`, lo que garantiza idempotencia). `ProgramWorkflow` interpreta el grafo de la versión con que entró: esperas con `workflow.Sleep`, "esperar hasta evento" con signals (el router envía `SignalWorkflow` a las ejecuciones que esperan ese tipo de evento), splits por condición (gRPC `segments.IsMember`), aleatorios (hash determinista) y por modelo (gRPC `scorer.Score`, F6). Las acciones son activities: publicar `messages.send.requested`, llamadas a core (campo, lista), webhook HTTP, inscripción en otro programa. Cada paso publica `programs.node.entered` y `programs.node.exited`. Triggers de fecha y recurrentes: Temporal Schedules que corren una consulta diaria a segments.

### Inteligencia

- **ml (Python).** Jobs con `uv run`: extracción de features desde ClickHouse, recomendaciones (co-ocurrencia item-item + ALS con `implicit`), churn y CLV (LightGBM → ONNX con `onnxmltools`), send time (histograma de aperturas por hora por contacto con suavizado bayesiano), ciclo de vida (reglas RFM). Escribe artefactos en MinIO `models/<tenant>/<model>/<version>/`, el registro en Postgres schema `ml`, y predicciones batch en ClickHouse `contact_scores`. Publica `ml.model.trained` y, al activar, `ml.model.activated`.
- **scorer (Go).** gRPC `scorer.v1.Scorer`. Carga la versión activa por tenant desde MinIO al recibir `ml.model.activated`; ONNX Runtime (`yalue/onnxruntime_go`) para churn/CLV en línea; tablas item-item y factores ALS en memoria para `Recommend`; features calientes en Redis; filtra por disponibilidad con la caché de catálogo en Redis.
- **genai (Python, F10).** FastAPI detrás de `/genai`. Adaptador del router LLM multi-provider (A10) con límite de gasto por tenant en Redis. Endpoints de generación de texto e imagen, NL→DSL de segmento (validado contra el JSON Schema antes de devolver), descripción de segmento y asistente con herramientas que llaman `/admin/v1` con el JWT del usuario, con confirmación explícita antes de cualquier escritura.

### Negocio y medición

- **analytics (NestJS, F8).** Lee ClickHouse (vistas materializadas definidas en `deploy/clickhouse`). Reportes por campaña/programa/canal, atribución último click con ventana configurable (tabla `attributed_revenue` recalculada por job incremental cada 5 min), dashboard del tenant, RFM. Guarda la configuración de atribución en Postgres schema `analytics`.
- **loyalty (NestJS, F9).** Programa, niveles, reglas, ledger de puntos (append-only), recompensas, vouchers. Consume `orders.created` y eventos de comportamiento; publica `loyalty.*`. Expone el contexto `loyalty` para render (REST interno, lote).
- **connectors (NestJS, F7/F10).** Audiencias de Ads (F7), e-commerce y webhooks salientes (F10).

### Infraestructura

PostgreSQL 17 (un cluster, un schema por servicio, un rol por servicio con acceso solo a su schema), ClickHouse 25.x, NATS 2.11 con JetStream, Redis 7, MinIO, Temporal (persistencia en Postgres, schema `temporal`), Mailpit, OpenTelemetry Collector → Prometheus, Tempo y Loki, con Grafana.

## Data model

### PostgreSQL (dueño → schema)

Toda tabla de negocio tiene `tenant_id uuid not null` y una política RLS `tenant_id = current_setting('app.tenant_id')::uuid`. Los servicios NestJS la fijan por transacción con una extensión de Prisma (`packages/ts-common/prisma-tenant`); los servicios Go con `SET LOCAL` en `libs/go/oe/pg`. Los IDs son UUID v7.

- **core → `identity`:** `tenants(id, name, timezone, default_locale, limits jsonb, status)`, `users(id, tenant_id, email, password_hash, mfa_secret, locale, failed_logins, locked_until)`, `roles(id, tenant_id, name)`, `role_permissions(role_id, module, action)` con `action ∈ {view, edit, launch, admin}`, `user_roles`, `api_clients(id, tenant_id, name, secret_hash, scopes text[], revoked_at)`, `refresh_tokens`, `audit_log(id, tenant_id, actor_type, actor_id, action, resource_type, resource_id, diff jsonb, at)`. `tenant_id` es null solo para el operador de plataforma.
- **core → `contacts`:** `field_definitions(tenant_id, field_id int, api_name, label, type, choices jsonb, is_system, unique)` con field IDs de sistema fijos 1–99 y custom desde 1000. `contacts(id, tenant_id, data jsonb /* {"3":"a@b.com"} */, email_norm text generated, external_id text, version bigint, created_at, updated_at, deleted_at)` con índice GIN en `data` y únicos parciales por `(tenant_id, email_norm)` y `(tenant_id, external_id)`. `unique_values(tenant_id, field_id, value, contact_id)` para campos custom únicos. `lists`, `list_members(list_id, contact_id, added_at)`, `consents(contact_id, channel, value, source, text, changed_at)` (historial append-only + valor vigente en `data` con field IDs 31 email, 32 SMS, 33 push), `relational_tables(tenant_id, id, name, key_field, columns jsonb)`, `relational_rows(table_id, contact_id, key, data jsonb)`, `gdpr_requests(id, contact_id, kind, status, requested_at, completed_at)`, `identity_links(tenant_id, anonymous_id, contact_id, linked_at)`.
- **core → `events_registry`:** `external_events(tenant_id, id int, name, payload_schema jsonb)`.
- **core → `catalog` (F6):** `products(tenant_id, item_id, title, url, image, price, currency, category_path text[], brand, available, attrs jsonb, updated_at, deleted_at)`.
- **core → `devices`, `inbox` (F7):** `devices(id, tenant_id, contact_id, platform, token, app_id, last_seen)`, `inbox_messages(id, tenant_id, contact_id, title, body, image, action_url, sent_at, read_at, expires_at)`.
- **importer → `importer`:** `jobs(id, tenant_id, kind, status, params jsonb, progress jsonb, result_url, error_report_url, created_by, created_at, finished_at)`.
- **segments → `segments`:** `segments(id, tenant_id, name, definition jsonb, version, created_by)`, `runs(id, segment_id, started_at, finished_at, count, status)`, `schedules(segment_id, cron, next_run_at)`.
- **content → `content`:** `templates(id, tenant_id, name, channel, tree jsonb, updated_at)`, `shared_blocks(id, tenant_id, name, tree jsonb)`, `assets(id, tenant_id, key, mime, width, height, meta jsonb)`, `content_versions(id, tenant_id, template_id, subject, preheader, html, text, variables text[], created_at)` inmutable; F7: `web_pieces`, `wallet_templates`, `wallet_passes`.
- **campaigns → `campaigns`:** `campaigns(id, tenant_id, name, channel, status, audience jsonb, schedule jsonb, sender_id, ab jsonb, launched_at)`, `variants(id, campaign_id, content_version_id, weight, is_winner)`, `launches(id, campaign_id, audience_run_id, total, excluded jsonb)`, `sender_domains(id, tenant_id, domain, dkim_selector, dkim_private_enc, status, checked_at)`, `senders(id, tenant_id, domain_id, from_name, from_local, reply_to)`.
- **dispatcher → `dispatcher`:** `sends(message_id pk, tenant_id, channel, contact_id, status, provider_id, attempts, updated_at)`.
- **automation → `automation`:** `programs(id, tenant_id, name, status, active_version_id)`, `program_versions(id, program_id, number, graph jsonb, published_at)`.
- **ml → `ml`:** `models(id, tenant_id, kind, version, metrics jsonb, artifact_uri, status, trained_at, activated_at)`.
- **analytics → `analytics`:** `attribution_settings(tenant_id, window_days, model)`, `saved_views`.
- **loyalty → `loyalty`:** `programs`, `tiers(id, program_id, name, threshold, rank)`, `rules(id, program_id, kind, params jsonb)`, `ledger(id, tenant_id, contact_id, delta, reason, ref, expires_at, at)`, `balances(contact_id, points, tier_id, tier_since)`, `rewards`, `vouchers(code, reward_id, contact_id, redeemed_at)`.
- **connectors → `connectors`:** `connections(id, tenant_id, kind, config_enc, status)`, `sync_state`, `audiences(id, connection_id, segment_id, remote_id, last_sync)`, `webhooks(id, tenant_id, url, events text[], secret_enc)`, `webhook_deliveries`.

### ClickHouse (database `oe`)

Todas las tablas están ordenadas primero por `tenant_id`. Las escribe solo `collector/cmd/sink`, salvo `segment_members` (segments), `contact_scores` (ml) y `attributed_revenue` (analytics).

- `events(tenant_id UUID, event_id UUID, type LowCardinality(String), contact_id Nullable(UUID), anonymous_id String, occurred_at DateTime64(3), received_at DateTime64(3), url String, item_ids Array(String), value Decimal(18,4), currency LowCardinality(String), props JSON)` — `ReplacingMergeTree(received_at)` particionada por `toYYYYMM(occurred_at)`, `ORDER BY (tenant_id, type, occurred_at, event_id)`, con proyección por `contact_id`.
- `orders(tenant_id, order_id, contact_id, occurred_at, total, currency, items Nested(item_id String, qty UInt32, price Decimal(18,4)))`.
- `message_events(tenant_id, message_id, contact_id, channel, kind /* sent delivered open click bounce_hard bounce_soft complaint unsub failed */, campaign_id Nullable(UUID), program_id Nullable(UUID), node_id String, variant_id Nullable(UUID), link_idx Nullable(UInt16), machine UInt8, occurred_at)`.
- `contacts_replica(tenant_id, contact_id, version UInt64, deleted UInt8, fields Map(String, String), lists Array(UUID), updated_at)` — `ReplacingMergeTree(version)`, alimentada por `contacts.upserted`/`contacts.deleted`.
- `products_replica`, `program_events(tenant_id, program_id, version_id, node_id, contact_id, kind /* entered exited waited suppressed */, branch String, occurred_at)`, `segment_members(tenant_id, segment_id, run_id, contact_id)`, `contact_scores(tenant_id, contact_id, churn Float32, clv Float32, lifecycle LowCardinality(String), best_hour UInt8, model_version String, updated_at)`, `attributed_revenue(tenant_id, order_id, message_id, campaign_id, program_id, channel, revenue, occurred_at)`.

### Redis (efímero, reconstruible)

`evt:*` dedupe, `rl:*` token buckets, `freq:<tenant>:<contact>:<yyyymmdd>` frecuencia, `supp:<tenant>:<channel>` sets de supresión, `feat:*` features, `cat:<tenant>:<item>` disponibilidad, `llm:spend:<tenant>:<yyyymm>`.

### MinIO (buckets)

`assets`, `imports`, `exports`, `models`, `opendata`, `wallet`.

## Interfaces

### C1 — Envelope de eventos NATS

Cada mensaje JetStream es JSON con cabecera `Nats-Msg-Id = id` (deduplicación de JetStream, ventana de 2 min):

```json
{ "id": "uuidv7", "type": "contacts.upserted", "schema_version": 1,
  "tenant_id": "uuid", "occurred_at": "RFC3339 ms", "source": "core",
  "contact_id": "uuid|null", "trace_parent": "w3c", "data": { } }
```

Subject: `oe.<type>.<tenant_id>` (ej. `oe.behavior.tracked.0192...`). Streams (retención por límites, archivo, réplica 1): `CONTACTS` (`oe.contacts.>`, `oe.consent.>`, `oe.identity.>`), `BEHAVIOR` (`oe.behavior.>`, `oe.external_event.>`, `oe.orders.>`), `MESSAGES` (`oe.messages.>`), `SEGMENTS`, `PROGRAMS`, `CATALOG`, `ML`, `LOYALTY`, `SYSTEM`. Consumidores durables con nombre `<servicio>-<propósito>`. Esquemas en `contracts/events/<type>.schema.json`; CI valida fixtures en `contracts/events/examples/`.

| type | data (campos clave) | fase |
|---|---|---|
| `contacts.upserted` | `version, fields{fieldId:value}, changed[fieldId], lists[]` | F1 |
| `contacts.deleted` | `reason: gdpr\|api` | F1 |
| `consent.changed` | `channel, value, source` | F1 |
| `identity.linked` | `anonymous_id` | F2 |
| `behavior.tracked` | `event_id, kind: page_view\|product_view\|search\|cart\|purchase\|custom, anonymous_id, url, item_ids, value, currency, props` | F2 |
| `external_event.triggered` | `event_id, external_event_id, name, payload` | F2 |
| `orders.created` | `order_id, total, currency, items[]` | F2 |
| `segments.run.completed` | `segment_id, run_id, count` | F3 |
| `messages.send.requested` | `message_id, channel, contact_id, content_version_id, sender_id, campaign_id?, program_id?, node_id?, variant_id?, send_at?, context{event?, items?}` | F4 |
| `messages.sent` / `.failed` / `.delivered` | `message_id, channel, provider_id?, error?` | F4 |
| `messages.opened` / `.clicked` | `message_id, link_idx?, machine` | F4 |
| `messages.bounced` / `.complained` / `.unsubscribed` | `message_id, bounce_type?, channel` | F4 |
| `programs.version.published` / `programs.status.changed` | `program_id, version_id, status` | F5 |
| `programs.node.entered` / `.exited` | `program_id, version_id, node_id, branch?` | F5 |
| `catalog.product.upserted` / `.deleted` | `item_id, fields` | F6 |
| `ml.model.trained` / `.activated` | `model_id, kind, version, artifact_uri` | F6 |
| `loyalty.points.changed` / `.tier.changed` / `.reward.redeemed` | `delta, balance, tier_id` | F9 |

### C2 — API pública `/api/v3` (A1)

OpenAPI en `contracts/openapi/public-v3.yaml`. Auth: `POST /api/v3/oauth/token` (client credentials) → JWT Bearer 1 h. Respuestas:

```json
{ "replyCode": 0, "replyText": "OK", "data": { } }
```

`replyCode ≠ 0` en errores de negocio con HTTP 4xx; errores por ítem en lotes van dentro de `data.errors[{index, key, code, text}]`. Operaciones largas devuelven `{ "job_id": "..." }` y se consultan en `GET /api/v3/jobs/{id}`. Rutas por fase (dueño entre paréntesis):

- F1 (core): `GET/POST /field`, `GET /field/{id}/choice`, `PUT/POST /contact?create_if_not_exists=1` (lote), `POST /contact/delete`, `POST /contact/getdata` (`keyId`, `keyValues[]`, `fields[]`), `GET/POST /contactlist`, `POST /contactlist/{id}/add|delete`, `POST /contact/{id}/consent`, `POST /gdpr/{export|forget}`. (importer): `POST /import`, `POST /export`, `GET /jobs/{id}`.
- F2 (core): `GET/POST /event`. (collector): `POST /event/{id}/trigger` (`key_id`, `external_id`, `data`), `POST /event/{id}/trigger-multiple`, `POST /orders`.
- F3 (segments): `GET /filter`, `GET /filter/{id}/count`, `GET /filter/{id}/contacts?offset&limit`.
- F4 (campaigns): `GET/POST /email`, `POST /email/{id}/launch`, `POST /email/{id}/sendtestmail`, `GET /email/{id}/responsesummary`. (dispatcher vía campaigns): `POST /email/transactional`.
- F5 (automation): `GET /program`, `POST /program/{id}/trigger` (inscripción manual).
- F6 (core): `PUT /catalog/items` (stream), `POST /catalog/items/delete`. (personalize): `GET /recommendations`.
- F7 (core): `POST /mobile/devices`, `GET /mobile/inbox`. (campaigns): `POST /sms`, `POST /push`.
- F8 (analytics): `GET /analytics/campaigns/{id}`, `GET /opendata/exports`.
- F9 (loyalty): `GET /loyalty/contacts/{id}`, `POST /loyalty/contacts/{id}/redeem`.
- F10 (connectors): `GET/POST /webhooks`.

### C3 — API de la consola `/admin/v1`

Un archivo OpenAPI por servicio en `contracts/openapi/admin-v1/<service>.yaml`. JSON plano (sin envelope), errores RFC 9457 (`application/problem+json`), paginación por cursor `?cursor&limit` → `{items, next_cursor}`. Auth: JWT de usuario; cada servicio verifica permiso `module:action` con el guard/middleware común. `packages/ts-contracts` genera clientes tipados (`openapi-typescript`) que usa admin-web.

### C4 — API interna `/internal/v1`

Solo red interna de Compose (no pasa por gateway) con token `typ=service`. Contratos mínimos:

- core: `POST /internal/v1/contacts/batch-upsert` (usa importer), `POST /internal/v1/contacts/lookup` (`{tenant_id, contact_ids[], field_ids[]}` → mapa; usan dispatcher y engine), `GET /internal/v1/contacts/stream?tenant_id&fields=` (NDJSON; usa importer), `POST /internal/v1/contacts/{id}/fields`, `POST /internal/v1/lists/{id}/members`.
- content: `GET /internal/v1/content-versions/{id}` → `{subject, preheader, html, text, variables}`.
- campaigns: `GET /internal/v1/senders/{id}` → `{from, reply_to, domain, dkim_selector, dkim_private_pem}`.
- dispatcher: `POST /internal/v1/render` (`{content_version_id | draft{subject, html, text}, contact_id?, sample_context}` → `{subject, html, text, errors[]}`), `POST /internal/v1/send-test`.
- loyalty: `POST /internal/v1/context` (`{tenant_id, contact_ids[]}` → contexto `loyalty` por contacto).

### C5 — gRPC (`proto/`, buf, Go server + TS/Go clients)

```proto
service Segments {
  rpc Count(CountRequest) returns (CountReply);          // tenant_id, definition_json | segment_id
  rpc IsMember(IsMemberRequest) returns (IsMemberReply);  // tenant_id, segment_id | definition_json, contact_id
  rpc Materialize(MaterializeRequest) returns (MaterializeReply); // → run_id, count
}
service Scorer {
  rpc Score(ScoreRequest) returns (ScoreReply);           // tenant_id, contact_id, kinds[churn,clv,best_hour,lifecycle]
  rpc Recommend(RecommendRequest) returns (RecommendReply); // tenant_id, logic, contact_id?, item_id?, cart[], filters{category,price_min,price_max,available}, limit
}
```

Metadata `authorization: Bearer <service token>` y `traceparent`.

### C6 — DSL de segmentos (`contracts/dsl/segment.schema.json`)

```json
{ "version": 1, "root": { "op": "and", "children": [
  { "kind": "field", "field_id": 1003, "cmp": "eq", "value": "BR" },
  { "kind": "behavior", "event": "purchase", "within": { "days": 30 }, "count": { "gte": 1 },
    "where": [{ "prop": "category", "cmp": "contains", "value": "calzado" }] },
  { "op": "not", "children": [{ "kind": "message", "channel": "email", "action": "open", "within": { "days": 60 } }] },
  { "kind": "list", "list_id": "uuid" },
  { "kind": "segment", "segment_id": "uuid" },
  { "kind": "relational", "table_id": "uuid", "where": [{ "column": "especie", "cmp": "eq", "value": "perro" }] },
  { "kind": "score", "score": "churn", "cmp": "gte", "value": 0.7 },
  { "kind": "loyalty", "attr": "tier", "cmp": "eq", "value": "gold" }
]}}
```

`kind` `score` se habilita en F6 y `loyalty` en F9; el compilador de F3 rechaza los kinds que no conoce con un error tipado. El compilador genera **una** consulta ClickHouse que devuelve `contact_id`: combina `contacts_replica FINAL` con subconsultas `IN` por criterio, y la parte `relational` se resuelve con una tabla `relational_replica` (F3). Límite: profundidad 5, 50 criterios.

### C7 — Grafo de programas (`contracts/dsl/program.schema.json`)

```json
{ "version": 1, "trigger": { "type": "behavior", "event": "cart", "reentry": { "mode": "every", "days": 7 } },
  "nodes": [
    { "id": "n1", "type": "wait", "duration": "PT2H" },
    { "id": "n2", "type": "wait_until", "event": "purchase", "timeout": "P2D" },
    { "id": "n3", "type": "split_condition", "definition": { "...": "C6 root" } },
    { "id": "n4", "type": "split_random", "weights": [50, 50] },
    { "id": "n5", "type": "split_model", "score": "churn", "threshold": 0.7 },
    { "id": "n6", "type": "send", "channel": "email", "content_version_id": "uuid", "sender_id": "uuid", "sto": false },
    { "id": "n7", "type": "update_field", "field_id": 1010, "value": "{{event.props.sku}}" },
    { "id": "n8", "type": "list", "op": "add", "list_id": "uuid" },
    { "id": "n9", "type": "webhook", "url": "https://...", "body": "{...}" },
    { "id": "n10", "type": "enroll", "program_id": "uuid" },
    { "id": "n11", "type": "exit" } ],
  "edges": [ { "from": "trigger", "to": "n1" }, { "from": "n2", "to": "n3", "branch": "event" }, { "from": "n2", "to": "n11", "branch": "timeout" } ] }
```

Tipos de trigger: `segment_entry`, `external_event`, `behavior`, `field_change`, `date_field`, `schedule`, `manual`, `loyalty` (F9). El `message_id` de un `send` es `uuidv5(workflowRunId + node_id)`, lo que hace idempotentes los reintentos de Temporal.

### C8 — Personalización (`contracts/dsl/personalization.md`)

Subconjunto de Liquid: `{{ contact.first_name | default: "cliente" }}` (por `api_name`) o `{{ contact.f1003 }}` (por field ID), `{{ event.payload.tracking }}`, `{% if contact.f1003 == "BR" %}`, `{% for p in recs.personal limit:4 %}` (F6), `{{ loyalty.points }}` (F9). Filtros permitidos: `default, upcase, downcase, capitalize, date, money, truncate, url_encode`. Variables desconocidas renderizan vacío y se reportan en `errors[]` de la vista previa. content valida sintaxis al publicar; dispatcher renderiza.

### C9 — Token de tracking

`base64url(payload) + "." + base64url(HMAC-SHA256(key_tenant, payload))[:16]`, con payload binario compacto `{v:1, t:tenant_id, m:message_id, c:contact_id, k:kind(o|c|u|p), l:link_idx}`. Las URL originales de los links se guardan en Redis `link:<message_id>` (TTL 400 días) al renderizar, y en ClickHouse como fallback. La llave por tenant se deriva con HKDF de la clave maestra.

### C10 — Web SDK

```html
<script>window.oe=window.oe||function(){(oe.q=oe.q||[]).push(arguments)};oe('init',{tenant:'<public key>'});</script>
<script async src="https://<host>/c/sdk.js"></script>
```

Comandos: `identify({email|external_id})`, `page()`, `view(item_id)`, `search(term)`, `cart([{item_id, qty, price}])`, `purchase({order_id, items, total, currency})`, `track(name, props)`, `recs(el, {logic, limit, filters})` (F6), `pieces()` (F7). Transporte: `POST /c/v1/collect` con `{tenant_key, anonymous_id, events:[{event_id, kind, occurred_at, ...}]}`, cada 2 s o al ocultar la página.

### C11 — Reglas de concurrencia de archivos (para specs)

Los registros compartidos tienen un único dueño por paquete, y los demás paquetes crean archivos propios que el registro descubre:

- Prisma: esquema multiarchivo `services/<svc>/prisma/schema/<module>.prisma`.
- NestJS: cada módulo en `src/modules/<module>/`; `src/app.module.ts` lo edita solo la tarea "wiring" de la fase, que depende de los módulos.
- Compose: `deploy/compose/services/<svc>.yml` incluido desde `deploy/compose/docker-compose.yml` (lo edita solo F0.2 y la tarea de wiring de cada fase que suma servicios).
- ClickHouse: `deploy/clickhouse/migrations/<NNNN>_<name>.sql` con rango reservado por fase (F1: 0100–0199, F2: 0200–0299, …).
- admin-web: rutas en `src/app/[locale]/(console)/<feature>/`, mensajes en `messages/<locale>/<feature>.json`, entradas de navegación en `src/nav/<feature>.ts`, cargadas por `src/nav/index.ts` con import glob generado por `scripts/codegen/nav.mjs` (nadie edita `index.ts` a mano).
- Go: un módulo por servicio (`services/<svc>/go.mod`); `go.work` lo edita solo la tarea de scaffold de cada servicio nuevo.
- contracts: un archivo por evento y un OpenAPI por servicio.

## Decisions

- **D1 — Bus de eventos.** Chosen: NATS JetStream. Rejected: Kafka, por peso operativo en un solo host (A2); Redis Streams, por falta de deduplicación nativa y replay por consumidor; BullMQ como bus, porque no tiene clientes Go/Python.
- **D2 — Ejecución de programas.** Chosen: Temporal + workers Go. Rejected: motor propio con timers en Postgres. Esperas de semanas, reintentos, versionado de workflows e historial son exactamente lo que Temporal ya resuelve (NFR-11).
- **D3 — Almacén de comportamiento.** Chosen: ClickHouse. Rejected: PostgreSQL/TimescaleDB, porque no cumple NFR-5 con 100 M de eventos y conteos combinados ad hoc.
- **D4 — Segmentación en un solo motor.** Chosen: replicar contactos (y tablas relacionales) a ClickHouse y compilar cada segmento a una sola consulta. Rejected: evaluar la parte de perfil en Postgres, la de comportamiento en ClickHouse e intersectar en Go, porque mueve millones de IDs por la red en cada conteo.
- **D5 — Campos custom.** Chosen: `jsonb` indexado por field ID en Postgres + `Map` en ClickHouse. Rejected: EAV (joins por campo) y columnas creadas en runtime (migraciones por tenant).
- **D6 — Render.** Chosen: MJML compilado a HTML al publicar (content, Node) y personalización Liquid por mensaje en Go (dispatcher), que es también el renderizador de vistas previas. Rejected: gRPC dispatcher→content por mensaje (latencia y acople en caliente); renderizar en Node y en Go (divergencias entre vista previa y envío).
- **D7 — Identidad.** Chosen: módulo propio en core con `jose` (JWT RS256, JWKS). Rejected: Keycloak u Ory, que suman un servicio pesado y ocultan justo lo que el proyecto quiere estudiar; el alcance (client credentials, sesiones, MFA TOTP) es acotado.
- **D8 — Acceso a datos en NestJS.** Chosen: Prisma para CRUD y migraciones + Kysely para consultas dinámicas (búsqueda de contactos, filtros jsonb) sobre el mismo pool. Rejected: solo Prisma, porque no expresa bien filtros jsonb dinámicos.
- **D9 — Deployables iniciales.** Chosen: `core` reúne identity, contacts, events-registry, catalog, devices e inbox como módulos (A7). content, campaigns, automation, analytics, loyalty y connectors nacen como servicios separados porque tienen ciclos de cambio y dependencias distintos. Rejected: un servicio por módulo desde F0.
- **D10 — Servir modelos.** Chosen: entrenar en Python y servir en Go (ONNX Runtime + tablas en memoria). Rejected: servir desde Python (FastAPI), por latencia p99 y huella de memoria frente a NFR-7.
- **D11 — Gateway.** Chosen: Traefik (labels/archivos, rate limit nativo). Rejected: Kong, que requiere su propia base y plugins para lo mismo.
- **D12 — Timeline en F2.** Chosen: core lee ClickHouse directamente (solo lectura) para la timeline del contacto. Rejected: esperar a analytics (F8), que dejaría M2 sin algo visible.
- **D13 — Agenda de campañas.** Chosen: BullMQ interno de campaigns para envíos programados, por zona horaria y espera de A/B. Rejected: Temporal para campañas, porque es un caso simple de "ejecutar a la hora X" que no necesita historial durable por contacto.
- **D14 — Mobile.** Chosen: SDK y demo en Flutter (stack del autor). Rejected: SDKs nativos (non-goal del PRD).
- **D15 — Límite de frecuencia.** Chosen: se aplica en engine, antes de publicar el `send` de un programa (PRD A13). Rejected: aplicarlo en dispatcher para todo mensaje, porque bloquearía campañas one-shot y envíos de prueba.
- **D16 — Clave maestra.** Chosen: anillo `OE_MASTER_KEYS` con `kid`, HKDF-SHA256 por propósito y tenant, y sobres AES-256-GCM con el mismo formato en Go (`libs/go/oe/keyring`) y Node (`packages/ts-common/src/keyring`). Rejected: Vault, que es otro servicio más en un solo host; se puede sumar después detrás de la misma API.

## Risks

- **Superficie enorme para un proyecto de estudio (75 FR).** *Mitigation:* fases entregables en orden, cada una con un e2e verificable; F0–F5 forman el núcleo que da valor aunque F6–F10 se demoren.
- **Consistencia entre la réplica de ClickHouse y Postgres (retrasos, orden).** *Mitigation:* `version` monotónica por contacto con `ReplacingMergeTree(version)`; el lag del sink es métrica con alerta; los tests de segmentos esperan a que la réplica alcance la versión.
- **Prisma + RLS.** Prisma no fija variables de sesión de forma nativa. *Mitigation:* extensión de cliente que envuelve cada operación en una transacción con `SET LOCAL app.tenant_id`, con tests de acceso cruzado obligatorios (NFR-8) en F0.
- **Divergencia de Liquid entre la validación en content (Node) y el render en Go.** *Mitigation:* content solo valida sintaxis con la gramática del subconjunto (C8); toda vista previa pasa por dispatcher; hay una suite de fixtures de render compartida en `contracts/dsl/fixtures/`.
- **Versionado de workflows de Temporal al cambiar el intérprete.** *Mitigation:* versión del grafo congelada por ejecución, `workflow.GetVersion` para cambios del intérprete y tests de replay en CI.
- **Recursos de un solo host (ClickHouse + Temporal + NATS + todo lo demás).** *Mitigation:* perfiles de Compose (`core`, `data`, `ai`, `obs`), límites de memoria por contenedor y seed escalable (`SEED_SCALE`).
- **Dependencias externas sin credenciales (SES, Twilio, APNs, Meta/Google Ads).** *Mitigation:* cada adaptador tiene una implementación `fake` por defecto y los criterios de aceptación corren contra ella (PRD Q1, Q2).
- **Costo de LLM.** *Mitigation:* límite de gasto por tenant en genai, modelo barato por defecto y caché de respuestas por hash de prompt.

## Requirement coverage

| Requirement | Component(s) |
| --- | --- |
| FR-1 | core/identity, admin-web |
| FR-2 | core/identity, ts-common/auth, libs/go/oe/auth, admin-web |
| FR-3 | core/identity, admin-web |
| FR-4 | core/identity (OAuth token endpoint, JWKS), admin-web |
| FR-5 | admin-web (next-intl) |
| FR-6 | core/identity (audit_log), ts-common/audit, admin-web |
| FR-7 | core/contacts, admin-web |
| FR-8 | core/contacts (public API) |
| FR-9 | core/contacts |
| FR-10 | core/contacts, core timeline (ClickHouse), admin-web |
| FR-11 | importer, core internal batch, admin-web |
| FR-12 | importer, MinIO, core stream |
| FR-13 | core/contacts, importer, admin-web |
| FR-14 | core/contacts (consents), admin-web |
| FR-15 | core/contacts (gdpr), importer (export), collector/sink (anonimización ClickHouse), ml (reentrenamiento) |
| FR-16 | core/contacts (relational), importer, segments (relational_replica) |
| FR-17 | web-sdk, collector, core timeline, demo-shop |
| FR-18 | collector (identity resolution), core (identity_links), sink |
| FR-19 | core/events-registry, collector |
| FR-20 | collector, importer (CSV), sink |
| FR-21 | collector (dedupe, bot filter) |
| FR-22 | segments (compiler), contracts/dsl, admin-web |
| FR-23 | segments (Count), admin-web |
| FR-24 | segments |
| FR-25 | segments (scheduler, runs), admin-web |
| FR-26 | segments (public API) |
| FR-27 | content (blocks, MJML), dispatcher (render preview), admin-web |
| FR-28 | contracts/dsl/personalization, dispatcher, content (validation) |
| FR-29 | content (shared blocks, assets), admin-web |
| FR-30 | dispatcher (send-test), campaigns, admin-web |
| FR-31 | campaigns (schedule, BullMQ), dispatcher |
| FR-32 | campaigns (launch exclusions), dispatcher (consent/suppression) |
| FR-33 | campaigns (A/B), analytics reads via ClickHouse in campaigns |
| FR-34 | tracker, dispatcher, sink, campaigns (response summary) |
| FR-35 | dispatcher (headers), tracker (unsub), core (consent), admin-web (preference center) |
| FR-36 | campaigns (sender domains), dispatcher (DKIM), admin-web |
| FR-37 | engine/collector trigger → dispatcher; campaigns (transactional API) |
| FR-38 | automation, contracts/dsl/program, admin-web (React Flow) |
| FR-39 | engine (trigger-router, schedules), automation |
| FR-40 | engine (wait, wait_until signals) |
| FR-41 | engine (splits), segments (IsMember), scorer (F6) |
| FR-42 | engine (activities), core internal, dispatcher |
| FR-43 | automation (versions), engine (version pinning) |
| FR-44 | engine (reentry, frequency cap Redis), dispatcher |
| FR-45 | automation (stats, journey), sink (program_events), admin-web |
| FR-46 | tests/e2e, demo-shop, engine, dispatcher |
| FR-47 | core/catalog, importer (feed), sink |
| FR-48 | ml (recs training), scorer (Recommend) |
| FR-49 | dispatcher (recs in render), personalize, web-sdk, content (product block), admin-web |
| FR-50 | ml (churn, CLV, lifecycle, STO), ClickHouse contact_scores, segments (score kind), admin-web |
| FR-51 | campaigns (STO schedule), engine (send sto), scorer |
| FR-52 | ml (registry, schedule), scorer (activation), admin-web |
| FR-53 | personalize, web-sdk, collector, analytics |
| FR-54 | dispatcher (SMS adapter), tracker (inbound STOP), campaigns, core (consent), admin-web |
| FR-55 | core/devices, dispatcher (FCM/APNs/WebPush), sdk/flutter, demo-app, web-sdk |
| FR-56 | core/inbox, sdk/flutter, demo-app, dispatcher |
| FR-57 | content (web pieces), personalize, web-sdk, admin-web |
| FR-58 | content (wallet), loyalty (F9 update), admin-web |
| FR-59 | connectors (ads audiences), segments, admin-web |
| FR-60 | analytics, ClickHouse MVs, admin-web |
| FR-61 | analytics (attribution job) |
| FR-62 | analytics, admin-web |
| FR-63 | analytics (RFM), segments, admin-web |
| FR-64 | importer (Open Data Parquet), admin-web |
| FR-65 | loyalty, admin-web |
| FR-66 | loyalty (tier evaluation), engine (loyalty trigger) |
| FR-67 | loyalty (rewards, vouchers), admin-web |
| FR-68 | loyalty (internal context), dispatcher, segments (loyalty kind), content (wallet) |
| FR-69 | genai, admin-web |
| FR-70 | genai, content (assets), admin-web |
| FR-71 | genai (NL→DSL), segments (validate/count), admin-web |
| FR-72 | genai, admin-web |
| FR-73 | genai (assistant tools), admin-web |
| FR-74 | connectors (Shopify, WooCommerce, Magento), collector |
| FR-75 | connectors (webhooks), all publishers |
| NFR-1 | todo el layout |
| NFR-2 | NATS (D1), Temporal (D2), ClickHouse (D3), gRPC (C5) |
| NFR-3 | collector, sink, scripts/bench |
| NFR-4 | tracker, scripts/bench |
| NFR-5 | segments, ClickHouse, scripts/bench |
| NFR-6 | dispatcher, scripts/bench |
| NFR-7 | scorer, personalize, scripts/bench |
| NFR-8 | RLS, ts-common/prisma-tenant, libs/go/oe/pg, tests de acceso cruzado por servicio |
| NFR-9 | core/identity, gateway, tracker (HMAC tokens), connectors (HMAC webhooks) |
| NFR-10 | core/contacts (gdpr), sink, ml |
| NFR-11 | JetStream, Temporal, dispatcher (idempotencia) |
| NFR-12 | libs/go/oe/otel, ts-common/otel, genai/ml OTel, deploy/observability |
| NFR-13 | deploy/compose, scripts/seed |
| NFR-14 | CI (.github/workflows), contracts validation, tests por servicio |
| NFR-15 | admin-web (shadcn/Radix, axe en e2e) |
| NFR-16 | admin-web (next-intl), dispatcher (filtros date/money por locale), campaigns (timezone) |
| NFR-17 | genai (router, spend limits), ml (sin APIs pagas) |

## Work breakdown

### F0 — Plataforma base (M0)

- **F0.1 — monorepo**: pnpm workspaces, Turborepo, `go.work`, workspace `uv`, lint/format (Biome, golangci-lint, ruff), Makefile, CI base. Files/dirs: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `go.work`, `pyproject.toml`, `biome.json`, `.golangci.yml`, `Makefile`, `.github/workflows/ci.yml`, `README.md`.
- **F0.2 — infra compose**: Postgres (roles por servicio), NATS + streams, ClickHouse, Redis, MinIO + buckets, Temporal, Mailpit, Traefik, observabilidad. Files/dirs: `deploy/compose/`, `deploy/nats/`, `deploy/temporal/`, `deploy/traefik/`, `deploy/observability/`, `deploy/postgres/`, `deploy/clickhouse/migrations/0001_init.sql`. Depends on: F0.1.
- **F0.3 — contracts base**: envelope C1, OpenAPI base (envelope, errores, auth), buf workspace, codegen TS/Go, validación en CI. Files/dirs: `contracts/events/envelope.schema.json`, `contracts/openapi/public-v3.yaml`, `contracts/openapi/admin-v1/identity.yaml`, `proto/buf.yaml`, `proto/buf.gen.yaml`, `packages/ts-contracts/`, `scripts/codegen/`. Depends on: F0.1.
- **F0.4 — libs/go/oe**: config, logger JSON, OTel, NATS publish/consume con envelope, JWT verify con JWKS, middleware de permisos, pg con `SET LOCAL`, cliente ClickHouse, envelope HTTP. Files/dirs: `libs/go/oe/`. Depends on: F0.3.
- **F0.5 — packages/ts-common**: módulo NestJS de auth (JWKS guard, permisos), tenant context + extensión Prisma RLS, interceptor de envelope público y problem+json, cliente NATS, OTel, audit. Files/dirs: `packages/ts-common/`. Depends on: F0.3.
- **F0.6 — core identity**: scaffold de core, schema `identity`, tenants, usuarios, invitaciones, roles/permisos, login + lockout + MFA TOTP, OAuth client credentials, JWKS, service tokens, audit log, tests de acceso cruzado. Files/dirs: `services/core/`. Depends on: F0.2, F0.5.
- **F0.7 — admin-web shell**: Next.js + shadcn + next-intl (es/pt/en), layout, auth por cookie, navegación por registro (C11), pantallas de tenants (operador), usuarios, roles, credenciales de API y audit log. Files/dirs: `apps/admin-web/`, `scripts/codegen/nav.mjs`. Depends on: F0.3; las pantallas dependen de los endpoints de F0.6.
- **F0.8 — gateway y seed**: rutas Traefik por servicio, rate limit, seed de operador + tenant demo, e2e de login. Files/dirs: `deploy/traefik/dynamic/`, `scripts/seed/platform/`, `tests/e2e/platform/`. Depends on: F0.6, F0.7.

### F1 — Base de contactos (M1)

- **F1.1 — contracts contactos**: OpenAPI pública y admin de fields, contacts, lists, consent, gdpr, import/export, jobs; eventos `contacts.*` y `consent.changed`; tabla de field IDs de sistema. Files/dirs: `contracts/openapi/public-v3.yaml` (sección contacts), `contracts/openapi/admin-v1/contacts.yaml`, `contracts/openapi/admin-v1/importer.yaml`, `contracts/events/contacts.*.schema.json`, `contracts/events/consent.changed.schema.json`, `contracts/dsl/system-fields.json`.
- **F1.2 — core contacts module**: schema `contacts`, field definitions, API de lotes con `key_id`, getdata, búsqueda (Kysely), listas, consentimientos, publicación de eventos, API interna (C4). Files/dirs: `services/core/src/modules/contacts/`, `services/core/prisma/schema/contacts.prisma`. Depends on: F1.1.
- **F1.3 — core gdpr y relational**: tablas relacionales (definición, filas, API), solicitudes GDPR de acceso y olvido con publicación de `contacts.deleted`. Files/dirs: `services/core/src/modules/relational/`, `services/core/src/modules/gdpr/`, `services/core/prisma/schema/relational.prisma`. Depends on: F1.2.
- **F1.4 — importer**: scaffold Go, jobs, import CSV streaming con mapeo y reporte de errores, export a MinIO con URL firmada, API `/import` `/export` `/jobs`. Files/dirs: `services/importer/`, `deploy/compose/services/importer.yml`. Depends on: F1.1 (contrato de la API interna de core); los tests de integración dependen de F1.2.
- **F1.5 — admin-web contactos**: gestor de campos, búsqueda y ficha de contacto (perfil, consentimientos), listas, asistente de import, exports, tablas relacionales. Files/dirs: `apps/admin-web/src/app/[locale]/(console)/contacts/`, `apps/admin-web/src/nav/contacts.ts`, `apps/admin-web/messages/*/contacts.json`. Depends on: F1.1.
- **F1.6 — wiring y e2e F1**: registrar módulos en `app.module.ts`, rutas gateway, e2e de import 1 M y lote parcial. Files/dirs: `services/core/src/app.module.ts`, `deploy/traefik/dynamic/contacts.yml`, `tests/e2e/contacts/`. Depends on: F1.2, F1.3, F1.4, F1.5.

### F2 — Comportamiento en vivo (M2)

- **F2.1 — contracts comportamiento**: eventos `behavior.tracked`, `external_event.triggered`, `orders.created`, `identity.linked`; API collect (C10), API de External Events y órdenes. Files/dirs: `contracts/events/behavior.*`, `contracts/events/external_event.*`, `contracts/events/orders.*`, `contracts/events/identity.*`, `contracts/openapi/collector.yaml`, `contracts/openapi/admin-v1/events.yaml`.
- **F2.2 — clickhouse y sink**: migraciones 0200–0299 (events, orders, contacts_replica, message_events, program_events), `cmd/sink` con consumidores por stream y escritura por lotes. Files/dirs: `deploy/clickhouse/migrations/02*.sql`, `services/collector/cmd/sink/`, `services/collector/internal/sink/`. Depends on: F2.1.
- **F2.3 — collector**: `cmd/collector`, validación, dedupe, filtro de bots, resolución de identidad, publicación NATS, trigger de External Events, órdenes. Files/dirs: `services/collector/cmd/collector/`, `services/collector/internal/collect/`, `services/collector/internal/identity/`. Depends on: F2.1.
- **F2.4 — web-sdk**: cola de comandos, cookie anónima, batching, `sendBeacon`, build < 10 KB, tests en navegador. Files/dirs: `packages/web-sdk/`. Depends on: F2.1.
- **F2.5 — core events y timeline**: módulo events-registry, módulo timeline (lectura ClickHouse), consumidor `identity.linked`. Files/dirs: `services/core/src/modules/events-registry/`, `services/core/src/modules/timeline/`, `services/core/prisma/schema/events.prisma`. Depends on: F2.1.
- **F2.6 — demo-shop y seed**: tienda Next.js con catálogo fijo, login, carrito, checkout con web-sdk; generador de seed (100k contactos, 10 M eventos) y bench de ingesta NFR-3. Files/dirs: `apps/demo-shop/`, `scripts/seed/behavior/`, `scripts/bench/collector/`. Depends on: F2.4.
- **F2.7 — admin-web comportamiento**: gestor de External Events, timeline en la ficha del contacto, snippet de instalación del SDK. Files/dirs: `apps/admin-web/src/app/[locale]/(console)/events/`, `apps/admin-web/src/components/contact-timeline/`, `apps/admin-web/src/nav/events.ts`, `apps/admin-web/messages/*/events.json`. Depends on: F2.1.
- **F2.8 — wiring y e2e F2**: compose y gateway para collector/sink, `app.module.ts`, e2e "carrito en demo-shop visible en timeline < 5 s". Files/dirs: `deploy/compose/services/collector.yml`, `deploy/traefik/dynamic/collector.yml`, `services/core/src/app.module.ts`, `tests/e2e/behavior/`. Depends on: F2.2, F2.3, F2.5, F2.6, F2.7.

### F3 — Segmentación (M3)

- **F3.1 — contracts segmentos**: `segment.schema.json` (C6), `proto/segments/v1`, OpenAPI admin y pública de segmentos, evento `segments.run.completed`. Files/dirs: `contracts/dsl/segment.schema.json`, `contracts/dsl/fixtures/segments/`, `proto/segments/v1/`, `contracts/openapi/admin-v1/segments.yaml`, `contracts/events/segments.*`.
- **F3.2 — compilador**: paquete Go DSL→SQL ClickHouse con tests golden contra fixtures y test de exactitud sobre dataset chico; migración `relational_replica` y su consumidor en sink. Files/dirs: `services/segments/internal/compiler/`, `deploy/clickhouse/migrations/03*.sql`, `services/collector/internal/sink/relational.go`. Depends on: F3.1.
- **F3.3 — segments service**: scaffold, schema Postgres, CRUD, Count, Materialize, runs e historial, scheduler, gRPC, API pública. Files/dirs: `services/segments/cmd/`, `services/segments/internal/api/`, `services/segments/internal/store/`, `services/segments/internal/scheduler/`, `services/segments/internal/grpc/`, `deploy/compose/services/segments.yml`. Depends on: F3.1; la integración depende de F3.2.
- **F3.4 — admin-web segment builder**: builder visual del DSL con grupos anidados, conteo en vivo con debounce, historial, listado. Files/dirs: `apps/admin-web/src/app/[locale]/(console)/segments/`, `apps/admin-web/src/components/segment-builder/`, `apps/admin-web/src/nav/segments.ts`, `apps/admin-web/messages/*/segments.json`. Depends on: F3.1.
- **F3.5 — bench y e2e F3**: bench NFR-5 con seed escalado, e2e del ejemplo de FR-22, rutas gateway. Files/dirs: `scripts/bench/segments/`, `tests/e2e/segments/`, `deploy/traefik/dynamic/segments.yml`. Depends on: F3.2, F3.3, F3.4.

### F4 — Email de punta a punta (M4)

- **F4.1 — contracts email**: C8 personalización + fixtures de render, C9 token, eventos `messages.*`, OpenAPI de content, campaigns y dispatcher interno, OpenAPI pública de email. Files/dirs: `contracts/dsl/personalization.md`, `contracts/dsl/fixtures/render/`, `contracts/events/messages.*`, `contracts/openapi/admin-v1/content.yaml`, `contracts/openapi/admin-v1/campaigns.yaml`, `contracts/openapi/internal/`.
- **F4.2 — content service**: scaffold NestJS, plantillas por árbol de bloques, bloques compartidos, assets MinIO, compilación MJML, validación de sintaxis Liquid, versiones inmutables, API interna. Files/dirs: `services/content/`. Depends on: F4.1.
- **F4.3 — dispatcher**: scaffold Go, consumidor de send requests, idempotencia, consentimiento y supresión, render Liquid, reescritura de enlaces y pixel, adaptador SMTP/SES con DKIM y List-Unsubscribe, throttling, render/send-test internos. Files/dirs: `services/dispatcher/`. Depends on: F4.1.
- **F4.4 — tracker**: scaffold Go, open/click/unsub/pref, detección de aperturas de máquina, webhook SES/SNS para bounces y quejas, publicación de eventos; consumidor en core que aplica bajas y supresión. Files/dirs: `services/tracker/`, `services/core/src/modules/contacts/consumers/suppression.consumer.ts`. Depends on: F4.1.
- **F4.5 — campaigns service**: scaffold NestJS, campañas, variantes, agenda (inmediata, programada, zona horaria), lanzamiento con exclusiones, A/B con ganador automático, sender domains con verificación DNS y DKIM, transaccionales, response summary. Files/dirs: `services/campaigns/`. Depends on: F4.1.
- **F4.6 — admin-web email**: editor de bloques con vista previa desktop/mobile (render vía dispatcher), biblioteca de assets y bloques, asistente de campaña, A/B, dominios, centro de preferencias público. Files/dirs: `apps/admin-web/src/app/[locale]/(console)/email/`, `apps/admin-web/src/app/[locale]/(console)/campaigns/`, `apps/admin-web/src/app/[locale]/(public)/preferences/`, `apps/admin-web/src/components/email-editor/`, `apps/admin-web/src/nav/email.ts`, `apps/admin-web/messages/*/email.json`. Depends on: F4.1.
- **F4.7 — wiring, bench y e2e F4**: compose, gateway, bench NFR-4 y NFR-6, e2e "campaña enviada a Mailpit, abierta y clickeada, contadores actualizados". Files/dirs: `deploy/compose/services/{content,campaigns,dispatcher,tracker}.yml`, `deploy/traefik/dynamic/email.yml`, `scripts/bench/tracker/`, `scripts/bench/dispatcher/`, `tests/e2e/email/`. Depends on: F4.2, F4.3, F4.4, F4.5, F4.6.

### F5 — Automation Center (M5)

- **F5.1 — contracts programas**: `program.schema.json` (C7) con fixtures, eventos `programs.*`, OpenAPI admin y pública de automation. Files/dirs: `contracts/dsl/program.schema.json`, `contracts/dsl/fixtures/programs/`, `contracts/events/programs.*`, `contracts/openapi/admin-v1/automation.yaml`.
- **F5.2 — automation service**: scaffold NestJS, programas, versiones, validación estructural (ciclos, nodos huérfanos, referencias), activar/pausar/detener, stats por nodo y recorrido desde ClickHouse. Files/dirs: `services/automation/`. Depends on: F5.1.
- **F5.3 — engine interpreter**: scaffold Go, worker Temporal, `ProgramWorkflow` con esperas, wait_until por signals, splits de condición y aleatorio, versión fijada, replay tests. Files/dirs: `services/engine/cmd/`, `services/engine/internal/workflow/`, `services/engine/internal/replay/`. Depends on: F5.1.
- **F5.4 — engine triggers y actions**: trigger-router NATS con índice de programas, reglas de reingreso, Temporal Schedules para fecha/recurrente, activities (send, update_field, list, webhook, enroll), cap de frecuencia. Files/dirs: `services/engine/internal/triggers/`, `services/engine/internal/activities/`, `services/engine/internal/frequency/`. Depends on: F5.3.
- **F5.5 — admin-web automation**: editor React Flow con paneles de configuración por nodo, validación en vivo, publicación, overlay de stats, recorrido de un contacto. Files/dirs: `apps/admin-web/src/app/[locale]/(console)/automation/`, `apps/admin-web/src/components/program-editor/`, `apps/admin-web/src/nav/automation.ts`, `apps/admin-web/messages/*/automation.json`. Depends on: F5.1.
- **F5.6 — wiring y e2e F5**: compose, gateway, e2e de carrito abandonado (FR-46) y de versionado (FR-43). Files/dirs: `deploy/compose/services/{automation,engine}.yml`, `deploy/traefik/dynamic/automation.yml`, `tests/e2e/automation/`. Depends on: F5.2, F5.4, F5.5.

### F6 — Catálogo y Predict (M6)

- **F6.1 — contracts predict**: `proto/scorer/v1`, API de catálogo y recomendaciones, eventos `catalog.*` y `ml.*`, formato de artefactos de modelo, kind `score` en C6. Files/dirs: `proto/scorer/v1/`, `contracts/openapi/catalog.yaml`, `contracts/events/catalog.*`, `contracts/events/ml.*`, `contracts/dsl/model-artifacts.md`, `contracts/dsl/segment.schema.json`.
- **F6.2 — core catalog**: módulo catalog con stream API, borrado, eventos; feed CSV programado en importer; réplica de productos en sink y caché Redis de disponibilidad. Files/dirs: `services/core/src/modules/catalog/`, `services/core/prisma/schema/catalog.prisma`, `services/importer/internal/catalogfeed/`, `services/collector/internal/sink/products.go`, `deploy/clickhouse/migrations/06*.sql`. Depends on: F6.1.
- **F6.3 — ml training**: proyecto Python, extracción de features, recs (co-ocurrencia + ALS), churn/CLV → ONNX, STO, lifecycle, registro y activación, predicciones batch a `contact_scores`, agenda. Files/dirs: `services/ml/`. Depends on: F6.1.
- **F6.4 — scorer**: scaffold Go, gRPC Score/Recommend, carga y hot reload de modelos, filtros de catálogo, bench NFR-7. Files/dirs: `services/scorer/`, `scripts/bench/scorer/`. Depends on: F6.1.
- **F6.5 — personalize y widgets**: servicio personalize (`/p/v1/recs`), comando `recs` del web-sdk, impresiones y clicks, widget en demo-shop. Files/dirs: `services/personalize/`, `packages/web-sdk/src/recs/`, `apps/demo-shop/src/components/recs/`. Depends on: F6.1.
- **F6.6 — integración predict**: `recs` en el render del dispatcher, STO en campaigns y engine, split_model en engine, kind `score` en el compilador de segmentos, bloque de productos en content. Files/dirs: `services/dispatcher/internal/render/recs.go`, `services/campaigns/src/modules/sto/`, `services/engine/internal/activities/model.go`, `services/segments/internal/compiler/score.go`, `services/content/src/modules/blocks/products/`. Depends on: F6.4.
- **F6.7 — admin-web predict y e2e**: catálogo, registro de modelos con métricas y activación, scores en la ficha, bloque de productos en el editor, e2e "bloque te puede interesar". Files/dirs: `apps/admin-web/src/app/[locale]/(console)/predict/`, `apps/admin-web/src/nav/predict.ts`, `apps/admin-web/messages/*/predict.json`, `deploy/compose/services/{ml,scorer,personalize}.yml`, `tests/e2e/predict/`. Depends on: F6.2, F6.3, F6.5, F6.6.

### F7 — Omnicanal (M7)

- **F7.1 — contracts canales**: API de dispositivos, bandeja, SMS y push; web pieces; wallet; adaptadores de canal del dispatcher; audiencias de Ads. Files/dirs: `contracts/openapi/admin-v1/channels.yaml`, `contracts/openapi/mobile.yaml`, `contracts/dsl/web-piece.schema.json`, `contracts/openapi/admin-v1/connectors.yaml`.
- **F7.2 — SMS**: adaptador Twilio + fake en dispatcher, conteo de segmentos GSM-7/UCS-2, STOP entrante en tracker, campañas SMS en campaigns. Files/dirs: `services/dispatcher/internal/channels/sms/`, `services/tracker/internal/inbound/sms/`, `services/campaigns/src/modules/sms/`. Depends on: F7.1.
- **F7.3 — push e inbox backend**: módulos devices e inbox en core, adaptadores FCM, APNs y Web Push (VAPID) + fake en dispatcher, tracking de apertura. Files/dirs: `services/core/src/modules/devices/`, `services/core/src/modules/inbox/`, `services/core/prisma/schema/mobile.prisma`, `services/dispatcher/internal/channels/push/`. Depends on: F7.1.
- **F7.4 — Flutter SDK y demo-app**: SDK (registro, push, in-app, inbox, tracking) y app demo. Files/dirs: `sdk/flutter/`, `apps/demo-app/`. Depends on: F7.1.
- **F7.5 — web pieces**: módulo en content, endpoint `/p/v1/pieces` en personalize, render en web-sdk con reglas de disparo. Files/dirs: `services/content/src/modules/web-pieces/`, `services/personalize/internal/pieces/`, `packages/web-sdk/src/pieces/`. Depends on: F7.1.
- **F7.6 — wallet**: módulo wallet en content (pases Apple con `passkit-generator`, Google Wallet API), actualización de pases. Files/dirs: `services/content/src/modules/wallet/`. Depends on: F7.1.
- **F7.7 — connectors y audiencias de Ads**: scaffold NestJS de connectors, adaptadores Meta Custom Audiences, Google Customer Match y fake, sync programado desde segments. Files/dirs: `services/connectors/`. Depends on: F7.1.
- **F7.8 — admin-web omnicanal y e2e**: pantallas de SMS, push, bandeja, web pieces, wallet y audiencias; nodos send de SMS/push en el editor; wiring y e2e omnicanal. Files/dirs: `apps/admin-web/src/app/[locale]/(console)/channels/`, `apps/admin-web/src/nav/channels.ts`, `apps/admin-web/messages/*/channels.json`, `deploy/compose/services/connectors.yml`, `tests/e2e/channels/`. Depends on: F7.2, F7.3, F7.5, F7.6, F7.7.

### F8 — Reporting (M8)

- **F8.1 — contracts analytics**: OpenAPI admin y pública de analytics y Open Data, definiciones de métricas. Files/dirs: `contracts/openapi/admin-v1/analytics.yaml`, `contracts/dsl/metrics.md`.
- **F8.2 — clickhouse analytics**: vistas materializadas por campaña, programa, canal y día; tabla y job de atribución. Files/dirs: `deploy/clickhouse/migrations/08*.sql`. Depends on: F8.1.
- **F8.3 — analytics service**: scaffold NestJS, reportes, atribución configurable, dashboard, RFM y creación de segmento desde un cuadrante. Files/dirs: `services/analytics/`. Depends on: F8.1; la integración depende de F8.2.
- **F8.4 — open data**: export Parquet programado por tipo de evento a MinIO desde importer. Files/dirs: `services/importer/internal/opendata/`. Depends on: F8.1.
- **F8.5 — admin-web reporting y e2e**: reportes de campaña/programa, dashboard, RFM, exports; test de exactitud contra conteo directo. Files/dirs: `apps/admin-web/src/app/[locale]/(console)/analytics/`, `apps/admin-web/src/nav/analytics.ts`, `apps/admin-web/messages/*/analytics.json`, `deploy/compose/services/analytics.yml`, `tests/e2e/analytics/`. Depends on: F8.2, F8.3, F8.4.

### F9 — Loyalty (M9)

- **F9.1 — contracts loyalty**: OpenAPI admin, pública e interna; eventos `loyalty.*`; kind `loyalty` en C6; trigger `loyalty` en C7; contexto `loyalty` en C8. Files/dirs: `contracts/openapi/admin-v1/loyalty.yaml`, `contracts/events/loyalty.*`, `contracts/dsl/loyalty-context.md`.
- **F9.2 — loyalty service**: scaffold NestJS, programa, niveles, reglas, ledger, balances, expiración, evaluación de niveles, recompensas y vouchers, consumidores de órdenes y eventos, contexto interno. Files/dirs: `services/loyalty/`. Depends on: F9.1.
- **F9.3 — integración loyalty**: contexto en el render del dispatcher, kind en el compilador de segmentos (réplica de balances en sink), trigger en engine, actualización de pases de wallet. Files/dirs: `services/dispatcher/internal/render/loyalty.go`, `services/segments/internal/compiler/loyalty.go`, `services/collector/internal/sink/loyalty.go`, `deploy/clickhouse/migrations/09*.sql`, `services/engine/internal/triggers/loyalty.go`, `services/content/src/modules/wallet/loyalty-sync/`. Depends on: F9.1.
- **F9.4 — admin-web loyalty y e2e**: configuración del programa, niveles, reglas, recompensas y vista de un miembro; e2e de compra → puntos → nivel → trigger. Files/dirs: `apps/admin-web/src/app/[locale]/(console)/loyalty/`, `apps/admin-web/src/nav/loyalty.ts`, `apps/admin-web/messages/*/loyalty.json`, `deploy/compose/services/loyalty.yml`, `tests/e2e/loyalty/`. Depends on: F9.2, F9.3.

### F10 — IA generativa e integraciones (M10)

- **F10.1 — contracts genai e integraciones**: OpenAPI de genai, herramientas del asistente, conectores e-commerce, webhooks salientes y firma. Files/dirs: `contracts/openapi/genai.yaml`, `contracts/dsl/assistant-tools.json`, `contracts/openapi/admin-v1/connectors.yaml` (sección e-commerce y webhooks), `contracts/dsl/webhook-signature.md`.
- **F10.2 — genai service**: scaffold FastAPI + uv, adaptador del router LLM, límites de gasto, generación de texto e imagen (subida a content), NL→DSL validado, descripción de segmentos. Files/dirs: `services/genai/src/genai/{app,router,spend,content,segments}/`, `services/genai/tests/`. Depends on: F10.1.
- **F10.3 — asistente**: herramientas sobre `/admin/v1` con JWT del usuario, confirmación previa a escrituras, historial de conversación. Files/dirs: `services/genai/src/genai/assistant/`. Depends on: F10.2.
- **F10.4 — conectores e-commerce**: Shopify, WooCommerce y Magento (clientes, productos y órdenes vía webhooks + backfill) en connectors. Files/dirs: `services/connectors/src/modules/ecommerce/`. Depends on: F10.1.
- **F10.5 — webhooks salientes**: suscripciones, consumidor de eventos, entrega con reintentos y firma HMAC. Files/dirs: `services/connectors/src/modules/webhooks/`. Depends on: F10.1.
- **F10.6 — admin-web IA e integraciones y e2e**: panel de generación en el editor de email, segmento por lenguaje natural, asistente en la consola, conexiones e-commerce, webhooks; wiring y e2e. Files/dirs: `apps/admin-web/src/app/[locale]/(console)/integrations/`, `apps/admin-web/src/components/ai/`, `apps/admin-web/src/nav/integrations.ts`, `apps/admin-web/messages/*/ai.json`, `deploy/compose/services/genai.yml`, `tests/e2e/ai/`. Depends on: F10.2, F10.3, F10.4, F10.5.

## Addendum A — reconciliación con las specs (2026-09-17)

Al escribir las specs aparecieron huecos en este documento. Las specs los resolvieron así, y **las specs mandan** en nombres de archivo y contratos cuando difieren de lo de arriba:

- **Contratos internos por fase.** `contracts/openapi/internal/` existe desde F1 (`core.yaml`, F1.1.T3). Se suman `core-behavior.yaml` (F2: `POST /internal/v1/contacts/resolve`, `GET /internal/v1/external-events/{id}`), `core-mobile.yaml` (F7: dispositivos e inbox), en automation `GET /internal/v1/programs/active` y `GET /internal/v1/program-versions/{id}` (F5), y en core `GET /internal/v1/tenants/{id}/limits` (F5).
- **Eventos nuevos en C1.**
  - `system.audit.recorded` (los servicios alimentan el audit log de FR-6), `system.tenant.created`, `system.api_client.revoked`, `system.job.completed` y `oe.system.dead_letter` (F0/F1).
  - `relational.rows.changed` (F3.2.T2).
  - `programs.node.suppressed` y `programs.enrollment.requested` (F5).
  - `messages.send.requested` suma `test` y `to_override` (F4).
- **Outbox.** core publica sus eventos a través de `contacts.outbox`, así un corte de NATS no pierde eventos (NFR-11, F1.2.T3).
- **Tablas no listadas en Data model.**
  - identity: `invitations`, `mfa_recovery_codes`.
  - connectors: `ecommerce_connections`, y `previous_secret_enc` en `webhooks` (para rotar el secreto).
  - Schema `genai` para las conversaciones del asistente.
  - ClickHouse: `segment_members` (migración 0301, F3.3.T4), vista de contactables diarios (F8) y vista de revenue por widget (F6.5.T3).
- **Sink.** Los consumidores de `message_events` (F4.4.T7) y `program_events` (F5.4.T7) se registran con `sink.Register` en `init()`, así que `cmd/sink/main.go` solo lo tocan los gates.
- **Clave del tenant en el SDK.** `tenant_key` es una clave pública derivada con HMAC y sin estado (`contracts/dsl/tenant-key.md`, F2.1.T1). core la expone en `GET /admin/v1/events/sdk-snippet`.
- **Vista previa y centro de preferencias.** admin-web pide vistas previas y envíos de prueba a content (`POST /admin/v1/content/preview` y `send-test`), que delega en dispatcher. tracker suma `POST /t/pref/{token}` para guardar el centro de preferencias. Como el token de C9 no trae hora, el umbral de escáneres (< 2 s) usa `sent_at` guardado en `link:<message_id>`.
- **Predict en la consola.** ml expone una API FastAPI chica para listar y activar modelos (`contracts/openapi/admin-v1/predict.yaml`, F6.3.T7). Las content versions suman `recs_slots` para configurar el bloque de productos (F6.1.T5).
- **Push.** Las campañas push y `POST /api/v3/push` son un módulo `push` de campaigns (F7.3.T4). El SDK móvil se autentica con `app_key` (F7.1.T1).
- **Operador de aniversario.** C6 suma `cmp: "anniversary"` para campos fecha, que usa el trigger `date_field` (F3.2.T5).
- **Extensión de UI.** El builder de segmentos (`criteria/<kind>.tsx` + `criteria/index.ts`) y el editor de email (`blocks/<type>.tsx` + `blocks/index.ts`) tienen estructura fija y exponen `ai-slot.tsx` (F3.4.T1, F4.6.T1). Así F6, F9 y F10 los extienden sin editar el componente raíz.
- **Concurrencia (amplía C11).**
  - Los mensajes de admin-web van por subfeature (`messages/<locale>/contacts-fields.json`, …).
  - `package.json` y `go.mod` de cada paquete los edita solo su tarea de scaffold.
  - Las tareas que agregan schema Prisma al mismo servicio van en serie, porque comparten `prisma/migrations/`.
- **Bootstrap.** El operador inicial se crea con el CLI de core `cli create-operator` (F0.6.T3). `/api/v3/jobs` es de importer (F1.6.T2).
