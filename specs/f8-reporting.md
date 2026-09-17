---
type: spec
project_id: open-emarsys
phase: 8
version: 0.1
depends_on:
  - docs/arch/001-open-emarsys.md
  - docs/prd/001-open-emarsys.md
consumed_by:
  - orch-atomizer
generated_by: orch-spec
generated_at: 2026-09-17
title: Reporting
---

# F8 — Reporting

Milestone M8 del PRD: reportes por campaña y programa, atribución de revenue, dashboard del tenant, RFM y export Open Data. Cubre FR-60 a FR-64. Arquitectura: `docs/arch/001-open-emarsys.md`, componente *analytics*, tablas ClickHouse de *Data model* y paquetes F8.1–F8.5 de *Work breakdown*.

## F8.1 — Package: contracts analytics

### F8.1.T1 — Definiciones de métricas

Escribir `contracts/dsl/metrics.md`: definición exacta de cada métrica que muestran los reportes (FR-60, FR-62), expresada sobre las tablas ClickHouse de *Data model* (`message_events`, `orders`, `attributed_revenue`, `contacts_replica`). Incluir: enviados, entregados, aperturas únicas y totales (excluyendo `machine = 1`), clicks únicos y totales, CTR, CTOR, bounces duros y blandos, quejas, bajas, revenue atribuido, contactables por canal (opt-in vigente en field IDs 31/32/33 y no suprimido). Definir la atribución último click (FR-61): ventana en días desde el click, qué pasa con varios clicks (gana el último anterior a la orden), canal y desempate. Definir RFM (FR-63): cortes por quintiles por tenant, recency en días, frequency = órdenes en 365 días, monetary = suma de `total`, y los 11 segmentos nombrados (champions, loyal, at risk, etc.) por combinación R/F.

Done when: el documento tiene una fórmula SQL de referencia por métrica y un ejemplo numérico de atribución con 2 clicks y 1 orden que resuelve sin ambigüedad.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Documento de definiciones con SQL de referencia; requiere precisión pero no diseño de seguridad.
- **Dependencies**: F7.8.T1
- **Files**:
  - `contracts/dsl/metrics.md`

### F8.1.T2 — OpenAPI admin de analytics

Escribir `contracts/openapi/admin-v1/analytics.yaml` siguiendo C3 (JSON plano, errores RFC 9457, paginación por cursor, auth JWT de usuario con permiso `analytics:view` y `analytics:edit`). Endpoints: `GET /admin/v1/analytics/campaigns/{id}` (totales + serie temporal por hora/día, por variante), `GET /admin/v1/analytics/programs/{id}` (totales y por nodo `send`), `GET /admin/v1/analytics/dashboard?from&to` (tarjetas de FR-62), `GET/PUT /admin/v1/analytics/attribution-settings` (`window_days`, `model`), `GET /admin/v1/analytics/rfm` (matriz R×F con conteos y revenue), `POST /admin/v1/analytics/rfm/segments` (crea segmento desde un cuadrante, FR-63), `GET /admin/v1/opendata/exports` y `PUT /admin/v1/opendata/settings` (FR-64). Los nombres de métricas son los de F8.1.T1.

Done when: `pnpm --filter ts-contracts codegen` genera tipos sin errores y el linter de OpenAPI del CI (F0.3) pasa sobre el archivo.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Contrato OpenAPI siguiendo convenciones ya fijadas en C3.
- **Dependencies**: F8.1.T1
- **Files**:
  - `contracts/openapi/admin-v1/analytics.yaml`

### F8.1.T3 — API pública de analytics y Open Data

Agregar a `contracts/openapi/public-v3.yaml` las rutas de F8 de C2: `GET /api/v3/analytics/campaigns/{id}` (response summary con las métricas de F8.1.T1 dentro del envelope `replyCode/replyText/data`) y `GET /api/v3/opendata/exports` (lista de archivos Parquet disponibles con URL firmada y expiración). Scopes OAuth `analytics.read` y `opendata.read`. No modificar otras secciones del archivo.

Done when: el linter de OpenAPI pasa y el diff del archivo solo agrega las dos rutas y sus schemas.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 1h
- **Reason**: Agregado mecánico a un OpenAPI existente con el envelope ya definido.
- **Dependencies**: F8.1.T1
- **Files**:
  - `contracts/openapi/public-v3.yaml`

## F8.2 — Package: clickhouse analytics

### F8.2.T1 — Vistas materializadas de reporting

Crear las migraciones ClickHouse del rango 0800–0809 (regla C11): tablas `AggregatingMergeTree` + vistas materializadas sobre `message_events` agregadas por `(tenant_id, campaign_id, variant_id, day)`, `(tenant_id, program_id, node_id, day)` y `(tenant_id, channel, day)`, con estados `uniqState(contact_id)` para únicos y `countState` para totales, excluyendo aperturas de máquina según F8.1.T1. Incluir una tabla diaria de contactables por canal calculada desde `contacts_replica FINAL` (la carga una consulta programada en F8.3). Agregar un test SQL que inserta un dataset chico conocido y compara cada vista contra el conteo directo sobre `message_events` (FR-60).

Done when: `make ch-migrate && make ch-test FILTER=0800` aplica las migraciones sobre un ClickHouse vacío y el test de igualdad pasa.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: SQL de ClickHouse con estados agregados; standard alcanza con las definiciones ya escritas.
- **Dependencies**: F8.1.T1
- **Files**:
  - `deploy/clickhouse/migrations/0800_report_campaign_daily.sql`
  - `deploy/clickhouse/migrations/0801_report_program_daily.sql`
  - `deploy/clickhouse/migrations/0802_report_channel_daily.sql`
  - `deploy/clickhouse/migrations/0803_contactable_daily.sql`
  - `deploy/clickhouse/tests/0800_reporting_test.sql`

### F8.2.T2 — Tabla y consulta de atribución

Crear la migración `0810` con `attributed_revenue` tal como la fija *Data model* (`ReplacingMergeTree` por `(tenant_id, order_id)`, para que recalcular una orden no duplique) y la consulta incremental parametrizada `deploy/clickhouse/queries/attribution.sql`: para las órdenes con `occurred_at` en `[from, to)` busca el último `click` del mismo contacto dentro de `window_days` anteriores (ASOF JOIN) y escribe el revenue atribuido con campaña, programa y canal. Test con los casos de FR-61: click a 3 días suma y click a 8 días con ventana 7 no suma; dos clicks gana el último.

Done when: `make ch-test FILTER=0810` pasa los tres casos.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: ASOF JOIN y reglas de ventana; lógica acotada y testeable.
- **Dependencies**: F8.1.T1
- **Files**:
  - `deploy/clickhouse/migrations/0810_attributed_revenue.sql`
  - `deploy/clickhouse/queries/attribution.sql`
  - `deploy/clickhouse/tests/0810_attribution_test.sql`

### F8.2.T3 — Agregado RFM por contacto

Crear la migración `0820` con una vista materializada `contact_rfm_state` sobre `orders` (última orden, cantidad de órdenes, suma de totales por contacto) y la consulta `deploy/clickhouse/queries/rfm.sql` que calcula los quintiles R, F y M por tenant y asigna el segmento RFM nombrado según F8.1.T1. La consulta devuelve la matriz R×F (conteo y revenue) y, con un parámetro de cuadrante, los `contact_id` que lo componen (FR-63).

Done when: `make ch-test FILTER=0820` verifica quintiles y asignación de segmento sobre un dataset de 100 contactos con valores conocidos.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: SQL analítico con quintiles; standard.
- **Dependencies**: F8.1.T1
- **Files**:
  - `deploy/clickhouse/migrations/0820_contact_rfm.sql`
  - `deploy/clickhouse/queries/rfm.sql`
  - `deploy/clickhouse/tests/0820_rfm_test.sql`

## F8.3 — Package: analytics service

### F8.3.T1 — Scaffold del servicio analytics

Crear `services/analytics` como servicio NestJS con `packages/ts-common` (auth JWKS + permisos, tenant context + extensión Prisma RLS, OTel, problem+json, cliente NATS), cliente ClickHouse de solo lectura, Prisma multiarchivo con `prisma/schema/base.prisma` (datasource, generator, schema `analytics`), `/healthz`, Dockerfile y tests base. No crear módulos de negocio: los agregan F8.3.T2–T6, y el registro en `app.module.ts` lo hace el gate F8.5.T1. `pnpm-workspace.yaml` ya incluye `services/*`; no editarlo.

Done when: `pnpm --filter analytics test` y `pnpm --filter analytics build` pasan, y `GET /healthz` responde 200 en el contenedor.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 1.5h
- **Reason**: Boilerplate NestJS repetido de servicios anteriores.
- **Dependencies**: F8.1.T2
- **Files**:
  - `services/analytics/package.json`
  - `services/analytics/tsconfig.json`
  - `services/analytics/Dockerfile`
  - `services/analytics/src/main.ts`
  - `services/analytics/src/app.module.ts`
  - `services/analytics/src/clickhouse/`
  - `services/analytics/prisma/schema/base.prisma`
  - `services/analytics/test/`

### F8.3.T2 — Reportes de campaña y programa

Módulo `reports`: implementa `GET /admin/v1/analytics/campaigns/{id}` y `GET /admin/v1/analytics/programs/{id}` de F8.1.T2 leyendo las vistas de F8.2.T1 (`uniqMerge`/`countMerge`) y `attributed_revenue`, con serie temporal por hora (últimas 72 h) o día. Siempre filtra por el `tenant_id` del token (NFR-8). Cubre FR-60.

Done when: los tests de integración con ClickHouse de testcontainers verifican que las cifras coinciden con el dataset de F8.2.T1 y que un usuario de otro tenant recibe 404.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Endpoints de lectura sobre vistas ya definidas.
- **Dependencies**: F8.3.T1, F8.2.T1
- **Files**:
  - `services/analytics/src/modules/reports/`

### F8.3.T3 — Atribución configurable y job incremental

Módulo `attribution`: tabla Prisma `attribution_settings` (schema `analytics`, RLS), endpoints `GET/PUT /admin/v1/analytics/attribution-settings` (ventana 1–90 días, por defecto 7, modelo `last_click`), y job cada 5 minutos (`@nestjs/schedule` con lock advisory de Postgres) que ejecuta `deploy/clickhouse/queries/attribution.sql` por tenant sobre la ventana `[último watermark − window_days, ahora)`. Cambiar la ventana recalcula los últimos 90 días de ese tenant. Guarda el watermark por tenant. Cubre FR-61.

Done when: el test de integración carga el dataset de F8.2.T2, corre el job y verifica los casos a 3 y 8 días; cambiar la ventana a 10 días hace que el caso de 8 días sume.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Job incremental con lock y watermark; standard.
- **Dependencies**: F8.3.T1, F8.2.T2
- **Files**:
  - `services/analytics/src/modules/attribution/`
  - `services/analytics/prisma/schema/attribution.prisma`
  - `services/analytics/prisma/migrations/20260917080300_attribution/`

### F8.3.T4 — Dashboard del tenant

Módulo `dashboard`: `GET /admin/v1/analytics/dashboard?from&to` devuelve las tarjetas de FR-62 (contactables por canal, crecimiento de la base, engagement por canal, revenue por canal) desde `0802`/`0803` y `attributed_revenue`, con todas las consultas en paralelo. Incluye la consulta programada diaria que carga la tabla de contactables de F8.2.T1. Objetivo: < 3 s para un rango de 90 días con el seed de NFR-13.

Done when: el test de integración verifica los valores de cada tarjeta y un bench con `SEED_SCALE=1` responde en < 3 s (p95 de 20 llamadas).

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2.5h
- **Reason**: Agregaciones de lectura y una consulta programada.
- **Dependencies**: F8.3.T1, F8.2.T1
- **Files**:
  - `services/analytics/src/modules/dashboard/`

### F8.3.T5 — RFM y segmento desde cuadrante

Módulo `rfm`: `GET /admin/v1/analytics/rfm` ejecuta `deploy/clickhouse/queries/rfm.sql` y devuelve la matriz; `POST /admin/v1/analytics/rfm/segments` recibe `{r, f, name}` y crea un segmento llamando a la API admin de segments (`/admin/v1/segments`) con el JWT del usuario. La definición usa el DSL C6 con un criterio `behavior` de `purchase` que reproduce el cuadrante (recency y frequency) y no una lista estática. Cubre FR-63.

Done when: el test de integración crea el segmento desde un cuadrante y `Count` de segments devuelve el mismo número que la celda de la matriz.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Traducción cuadrante→DSL con verificación cruzada; standard.
- **Dependencies**: F8.3.T1, F8.2.T3
- **Files**:
  - `services/analytics/src/modules/rfm/`

### F8.3.T6 — API pública de analytics

Módulo `public`: `GET /api/v3/analytics/campaigns/{id}` con el envelope C2 (`replyCode`, `replyText`, `data`), scope `analytics.read`, reutilizando el servicio de F8.3.T2. Cubre FR-60 vía API.

Done when: el test e2e del módulo obtiene un token client credentials con el scope y recibe el summary; sin el scope recibe 403 con `replyCode` distinto de 0.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 1h
- **Reason**: Adaptador fino sobre un servicio existente.
- **Dependencies**: F8.3.T2
- **Files**:
  - `services/analytics/src/modules/public/`

## F8.4 — Package: open data

### F8.4.T1 — Export Parquet programado

En importer, paquete `internal/opendata`: job diario por tenant que exporta a MinIO (bucket `opendata`) un archivo Parquet por tipo de evento del día anterior (`events` por `type`, `message_events`, `orders`) con `INSERT INTO FUNCTION s3(...) FORMAT Parquet` desde ClickHouse, con ruta `opendata/<tenant>/<table>/<type>/dt=YYYY-MM-DD/part.parquet`. Registra cada export en la tabla `jobs` de importer (`kind = opendata`). Solo corre para tenants con Open Data activado (settings en la misma tabla de jobs o en `params`). Excluye datos de contactos borrados por GDPR (NFR-10). Cubre FR-64.

Done when: `go test ./internal/opendata/...` con testcontainers genera el Parquet de un día y un test lo lee con DuckDB (`duckdb -c "select count(*) from 'part.parquet'"`) con el conteo esperado.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Integración ClickHouse→S3 con agenda; standard.
- **Dependencies**: F8.1.T3
- **Files**:
  - `services/importer/internal/opendata/export.go`
  - `services/importer/internal/opendata/export_test.go`

### F8.4.T2 — API de Open Data

En `internal/opendata`: handlers de `GET /api/v3/opendata/exports` (C2, scope `opendata.read`), `GET /admin/v1/opendata/exports` y `PUT /admin/v1/opendata/settings` (F8.1.T2) que listan archivos por fecha y tabla con URL firmada de MinIO (expira en 1 h) y activan o desactivan el export. El registro de las rutas en `cmd/importer/main.go` lo hace el gate F8.5.T1.

Done when: el test del handler lista los exports del test de F8.4.T1 y la URL firmada descarga el archivo.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 1.5h
- **Reason**: Handlers CRUD simples sobre datos ya producidos.
- **Dependencies**: F8.4.T1
- **Files**:
  - `services/importer/internal/opendata/api.go`
  - `services/importer/internal/opendata/api_test.go`

## F8.5 — Package: admin-web reporting y e2e

### F8.5.T1 — Wiring y e2e de F8

Cierre de fase. Registrar los módulos `reports`, `attribution`, `dashboard`, `rfm` y `public` en `services/analytics/src/app.module.ts`; registrar las rutas de opendata en `services/importer/cmd/importer/main.go`; crear `deploy/compose/services/analytics.yml` e incluirlo en `deploy/compose/docker-compose.yml`; agregar las rutas `/admin/v1/analytics`, `/api/v3/analytics` y `/admin/v1/opendata` en Traefik. E2E en `tests/e2e/analytics/`: sobre el seed, (1) las cifras del reporte de una campaña coinciden con el conteo directo en ClickHouse (FR-60); (2) una compra a 3 días de un click suma revenue y a 8 días no (FR-61); (3) cambiar el rango del dashboard responde < 3 s (FR-62); (4) click en un cuadrante RFM crea un segmento con el mismo conteo (FR-63); (5) el export Open Data de ayer es legible con DuckDB (FR-64); (6) axe sin violaciones AA en las pantallas de analytics (NFR-15).

Done when: `docker compose up` levanta analytics sano y `pnpm test:e2e --project analytics` pasa los seis escenarios.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Wiring de varias piezas y e2e de punta a punta; standard con contexto amplio.
- **Dependencies**: F8.3.T3, F8.3.T4, F8.3.T5, F8.3.T6, F8.4.T2, F8.5.T3, F8.5.T4, F8.5.T5
- **Files**:
  - `services/analytics/src/app.module.ts`
  - `services/importer/cmd/importer/main.go`
  - `deploy/compose/services/analytics.yml`
  - `deploy/compose/docker-compose.yml`
  - `deploy/traefik/dynamic/analytics.yml`
  - `tests/e2e/analytics/`

### F8.5.T2 — Shell de analytics en admin-web

Crear la entrada de navegación `src/nav/analytics.ts` (regla C11: el índice se regenera con `scripts/codegen/nav.mjs`, no editar `index.ts`), los mensajes `messages/{es,pt,en}/analytics.json` con las claves de todas las pantallas de F8 (reportes, dashboard, RFM, Open Data), el layout de la sección con tabs y el cliente tipado generado desde `contracts/openapi/admin-v1/analytics.yaml`. Permiso requerido: `analytics:view`.

Done when: `pnpm --filter admin-web build` pasa, la sección aparece en la navegación en los tres idiomas y un usuario sin permiso no la ve.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 1.5h
- **Reason**: Wiring de navegación, i18n y layout; mecánico.
- **Dependencies**: F8.1.T2
- **Files**:
  - `apps/admin-web/src/nav/analytics.ts`
  - `apps/admin-web/messages/es/analytics.json`
  - `apps/admin-web/messages/pt/analytics.json`
  - `apps/admin-web/messages/en/analytics.json`
  - `apps/admin-web/src/app/[locale]/(console)/analytics/layout.tsx`
  - `apps/admin-web/src/lib/api/analytics.ts`

### F8.5.T3 — Pantallas de reporte de campaña y programa

Páginas `analytics/campaigns/[id]` y `analytics/programs/[id]`: tarjetas de totales con tasas, gráfico temporal de aperturas y clicks, tabla por variante (A/B) o por nodo `send`, revenue atribuido, y enlace desde la ficha de campaña (F4) y de programa (F5). Números con `tabular-nums` y formato por locale (NFR-16). Cubre FR-60 en la consola.

Done when: el test de componentes con datos mock renderiza tarjetas y gráfico, y el test Playwright abre el reporte de una campaña del seed sin errores de consola.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: UI de datos con gráficos; standard.
- **Dependencies**: F8.5.T2
- **Files**:
  - `apps/admin-web/src/app/[locale]/(console)/analytics/campaigns/`
  - `apps/admin-web/src/app/[locale]/(console)/analytics/programs/`

### F8.5.T4 — Dashboard y RFM en admin-web

Página `analytics/dashboard` con selector de rango (recalcula todas las tarjetas, FR-62) y página `analytics/rfm` con la matriz R×F como heatmap accesible (tabla navegable por teclado con color y valor), panel de detalle del cuadrante y botón "Crear segmento" que llama a `POST /admin/v1/analytics/rfm/segments` y lleva al segmento creado (FR-63).

Done when: el test Playwright cambia el rango y ve las tarjetas actualizadas, y crea un segmento desde un cuadrante que abre en el builder.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: UI analítica con interacción; standard.
- **Dependencies**: F8.5.T2
- **Files**:
  - `apps/admin-web/src/app/[locale]/(console)/analytics/dashboard/`
  - `apps/admin-web/src/app/[locale]/(console)/analytics/rfm/`

### F8.5.T5 — Pantalla de Open Data y atribución

Página `analytics/settings`: activar Open Data, listado de exports por fecha y tabla con descarga, y configuración de la ventana de atribución (1–90 días) con aviso de que el cambio recalcula 90 días. Cubre FR-61 y FR-64 en la consola.

Done when: el test Playwright activa Open Data, ve un export del seed y cambia la ventana a 10 días con confirmación.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 1.5h
- **Reason**: Formularios y listado simples.
- **Dependencies**: F8.5.T2
- **Files**:
  - `apps/admin-web/src/app/[locale]/(console)/analytics/settings/`
