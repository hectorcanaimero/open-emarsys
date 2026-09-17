---
type: spec
project_id: open-emarsys
phase: 3
version: 0.1
depends_on:
  - docs/arch/001-open-emarsys.md
  - docs/prd/001-open-emarsys.md
consumed_by:
  - orch-atomizer
generated_by: orch-spec
generated_at: 2026-09-17
title: Segmentación
---

# F3 — Segmentación

Milestone M3 del PRD (FR-22 a FR-26, NFR-5). El servicio Go `segments` compila el DSL de C6 a una sola consulta ClickHouse sobre `contacts_replica` + eventos (decisión D4), cuenta, materializa, agenda ejecuciones y expone REST y gRPC (C5). Arquitectura: `docs/arch/001-open-emarsys.md`, secciones *Audiencia*, *ClickHouse*, C2, C3, C5, C6 y C11.

## F3.1 — Package: contracts segmentos

### F3.1.T1 — JSON Schema del DSL de segmentos y fixtures

Escribir `contracts/dsl/segment.schema.json` (draft 2020-12) exactamente con la forma de C6: nodo raíz `{version: 1, root}`, grupos `{op: and|or|not, children}` y criterios discriminados por `kind`: `field` (`field_id`, `cmp` según tipo: `eq, neq, in, contains, starts_with, gt, gte, lt, lte, between, is_empty, is_not_empty`, `value`), `behavior` (`event`: kinds de `behavior.tracked` o `external:<name>`, `within` `{days}|{from,to}`, `count` `{gte|lte|eq}`, `where[{prop, cmp, value}]`), `message` (`channel`, `action: send|open|click|bounce|unsub`, `within`, `campaign_id?`), `list`, `segment`, `relational` (`table_id`, `where[{column, cmp, value}]`), `score` y `loyalty` (reservados: presentes en el schema y marcados `x-available-from: F6/F9`). Límites de profundidad 5 y 50 criterios documentados con `x-limits`, porque JSON Schema no los expresa. En `contracts/dsl/fixtures/segments/`: 12 definiciones válidas (incluido el ejemplo literal de FR-22 y un "A menos B" de FR-24) y 6 inválidas (kind desconocido, cmp incompatible, profundidad 6, 51 criterios, `not` con dos hijos, `within` vacío), cada una con `expect.json` (`valid` y código de error esperado). Cubre FR-22, FR-24.

Done when: la validación de contratos de CI pasa, y un test en `contracts/` (ajv) confirma que las 12 válidas validan y las inválidas estructurales fallan. Los límites se prueban en F3.2.T1.

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Diseño del DSL central que comparten el builder, el compilador, el motor de programas y la IA de F10.
- **Dependencies**: F2.8.T1
- **Files**:
  - `contracts/dsl/segment.schema.json`
  - `contracts/dsl/fixtures/segments/`

### F3.1.T2 — Proto de segments, OpenAPI admin y pública, evento de ejecución

Escribir:
- `proto/segments/v1/segments.proto` con el servicio de C5 (`Count`, `IsMember`, `Materialize`). Los requests llevan `tenant_id` y `oneof {segment_id, definition_json}`. `CountReply{count, took_ms}`, `IsMemberReply{member}`, `MaterializeReply{run_id, count}`. Generar Go (`proto/gen/go/segments/v1`) y TS con `buf generate` y commitear lo generado.
- `contracts/openapi/admin-v1/segments.yaml` (C3): CRUD de segmentos, `POST /admin/v1/segments/count` (definición ad hoc, para el builder), `GET /admin/v1/segments/{id}/runs` (historial), `PUT /admin/v1/segments/{id}/schedule` (cron) y `POST /admin/v1/segments/{id}/run`.
- Sección `filter` de `contracts/openapi/public-v3.yaml` (C2): `GET /api/v3/filter`, `GET /api/v3/filter/{id}/count`, `GET /api/v3/filter/{id}/contacts?offset&limit` (máximo 10.000 por página, envelope `replyCode`).
- `contracts/events/segments.run.completed.schema.json` + ejemplo (C1).

Regenerar `packages/ts-contracts`. Cubre FR-23, FR-25, FR-26.

Done when: `buf lint proto && buf generate` sin errores y sin diff tras regenerar, el lint OpenAPI de CI pasa y `pnpm --filter ts-contracts build` compila.

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Contratos gRPC y REST de los que dependen engine (F5), campaigns (F4) y admin-web.
- **Dependencies**: F3.1.T1
- **Files**:
  - `proto/segments/v1/segments.proto`
  - `proto/gen/go/segments/v1/`
  - `contracts/openapi/admin-v1/segments.yaml`
  - `contracts/openapi/public-v3.yaml`
  - `contracts/events/segments.run.completed.schema.json`
  - `contracts/events/examples/segments.run.completed.json`
  - `packages/ts-contracts/src/generated/segments.ts`

## F3.2 — Package: compilador

### F3.2.T1 — Compilador DSL → SQL ClickHouse (perfil, comportamiento, mensajes, listas, segmentos)

Implementar `services/segments/internal/compiler`. `Compile(ctx, tenantID, def []byte, loader SegmentLoader) (Query, error)`: valida contra `contracts/dsl/segment.schema.json` (embebido con `go:embed` desde un copy step de `go generate`), aplica los límites (profundidad 5, 50 criterios, contando los expandidos de segmentos referenciados) y detecta ciclos entre segmentos. Genera **una** consulta parametrizada (nunca concatena valores) que devuelve `contact_id`:

`SELECT contact_id FROM oe.contacts_replica FINAL WHERE tenant_id = {t} AND deleted = 0 AND <expr>`

En `<expr>`, cada criterio se traduce así:
- `field` → comparaciones sobre `fields['<id>']` con cast por tipo de campo. Los tipos de campo se inyectan con `FieldTypes`; no hay consulta a Postgres dentro del compilador.
- `list` → `has(lists, {uuid})`.
- `behavior` → `contact_id IN (SELECT contact_id FROM oe.events WHERE tenant_id=… AND type=… AND occurred_at >= now() - INTERVAL … GROUP BY contact_id HAVING count() >= …)`, con `where` sobre `props`.
- `message` → subconsulta equivalente sobre `message_events`.
- `segment` → expansión inline de la definición cargada por `loader`.
- `and`/`or`/`not` → `AND`/`OR`/`NOT (…)`.

Los kinds `relational`, `score` y `loyalty` devuelven `ErrKindNotAvailable{kind}` (`relational` lo agrega F3.2.T3). Tests golden: cada fixture válida de `contracts/dsl/fixtures/segments/` tiene su `.sql` esperado en `testdata/golden/` (`-update` regenera), y cada inválida devuelve el código de su `expect.json`. Cubre FR-22, FR-24, NFR-5 (una sola consulta).

Done when: `go test ./services/segments/internal/compiler/...` pasa con todos los golden, los 6 inválidos con su código, el ciclo A→B→A detectado, y un test que verifica que ningún valor de usuario aparece literal en el SQL.

- **Model**: claude/claude-opus-5
- **Estimate**: 4h
- **Reason**: Compilador con requisitos de seguridad (inyección) y de rendimiento; es el núcleo técnico de M3.
- **Dependencies**: F3.1.T1, F3.3.T1
- **Files**:
  - `services/segments/internal/compiler/compiler.go`
  - `services/segments/internal/compiler/criteria.go`
  - `services/segments/internal/compiler/limits.go`
  - `services/segments/internal/compiler/schema.go`
  - `services/segments/internal/compiler/compiler_test.go`
  - `services/segments/internal/compiler/testdata/golden/`

### F3.2.T2 — Réplica relacional: migración, evento y publicación desde core

El arch no define un evento para filas relacionales (C1), así que esta tarea lo agrega. Escribir `contracts/events/relational.rows.changed.schema.json` + ejemplo (`table_id`, `op: upsert|delete`, `rows[{contact_id, key, data}]`, hasta 1.000 filas) y la migración ClickHouse `0300_relational_replica.sql` (rango F3 de C11): `relational_replica(tenant_id, table_id, contact_id, key, data Map(String,String), version UInt64, deleted UInt8)` con `ReplacingMergeTree(version)` y `ORDER BY (tenant_id, table_id, contact_id, key)`. En el módulo `relational` de core (F1.3), publicar el evento después de cada escritura exitosa (API y CSV) con el publisher NATS de `packages/ts-common`. Cubre FR-16 (en segmentos), FR-22.

Done when: la validación de contratos pasa, la migración aplica sobre ClickHouse limpio, y `pnpm --filter core test -- relational` incluye un test que verifica que un upsert de 3 filas publica un evento con esas 3 filas (NATS de testcontainers).

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Extensión acotada de un módulo existente más DDL; estándar.
- **Dependencies**: F3.1.T1
- **Files**:
  - `contracts/events/relational.rows.changed.schema.json`
  - `contracts/events/examples/relational.rows.changed.json`
  - `deploy/clickhouse/migrations/0300_relational_replica.sql`
  - `services/core/src/modules/relational/`

### F3.2.T3 — Consumidor de la réplica relacional y kind relational del compilador

Agregar al sink el consumidor durable `sink-relational` (`oe.relational.>`, stream `CONTACTS`), que escribe en `oe.relational_replica` por lotes con el framework de F2.2.T2, y registrarlo en `services/collector/cmd/sink/main.go`. En el compilador, implementar el kind `relational`: `contact_id IN (SELECT contact_id FROM oe.relational_replica FINAL WHERE tenant_id=… AND table_id=… AND deleted=0 AND <where sobre data[...]>)`, y agregar sus golden. Cubre FR-16, FR-22.

Done when: `go test ./services/collector/internal/sink/... ./services/segments/internal/compiler/...` pasa, con un test de integración del consumidor (upsert y delete de filas) y el golden de "mascota de especie perro".

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Consumidor sobre un framework ya hecho y un kind más del compilador con su patrón fijado.
- **Dependencies**: F3.2.T1, F3.2.T2
- **Files**:
  - `services/collector/internal/sink/relational.go`
  - `services/collector/internal/sink/relational_test.go`
  - `services/collector/cmd/sink/main.go`
  - `services/segments/internal/compiler/relational.go`
  - `services/segments/internal/compiler/testdata/golden/relational/`

### F3.2.T4 — Test de exactitud del compilador contra ClickHouse real

Test de integración (testcontainers ClickHouse con las migraciones 02xx y 03xx). Carga un dataset chico y controlado en `testdata/dataset.sql` (≈ 200 contactos, 5.000 eventos, mensajes, listas y filas relacionales, construidos para que cada criterio tenga positivos y negativos conocidos) y, para cada fixture válida, compara el resultado del SQL compilado con el conjunto esperado calculado a mano en `testdata/expected/<fixture>.json`. Incluye el ejemplo literal de FR-22 ("compró en 30 días Y NO abrió emails en 60") y FR-24 ("A menos B" = |A| − |A∩B|). Cubre FR-22, FR-24.

Done when: `go test -tags integration ./services/segments/internal/compiler/...` pasa, con igualdad exacta de conjuntos para todas las fixtures.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Construcción de datos de prueba y comparación; estándar pero minucioso.
- **Dependencies**: F3.2.T3
- **Files**:
  - `services/segments/internal/compiler/integration_test.go`
  - `services/segments/internal/compiler/testdata/dataset.sql`
  - `services/segments/internal/compiler/testdata/expected/`

### F3.2.T5 — Operador de aniversario para campos fecha

Agregar al DSL (C6) el operador `cmp: "anniversary"` para campos de tipo fecha, con `value: {offset_days: int (-365..365)}`: el contacto cumple si el mes y el día del campo coinciden con los de hoy + `offset_days`, en la zona horaria del tenant. Un 29 de febrero se evalúa el 28 en años no bisiestos. Es lo que usa el trigger `date_field` de F5 (cumpleaños, aniversario de alta).
- Schema: sumar el operador en `contracts/dsl/segment.schema.json`, válido solo con `field` de tipo fecha.
- Fixtures: una válida (`anniversary-birthday.json`) y una inválida (sobre un campo texto), con su `expect.json`.
- Compilador: `toMonth`/`toDayOfMonth` sobre `fields['<id>']` con parámetros para mes y día (nunca literales) y la regla del 29 de febrero. El "hoy" se inyecta con un `Clock` para poder testearlo.
- Admin-web no cambia: el selector de operadores ya se genera desde el schema.

Cubre FR-39 (trigger de fecha) y FR-22.

Done when: `go test ./services/segments/internal/compiler/...` pasa con el golden del operador, la fixture inválida rechazada y un test con reloj fijo en 2027-02-28 que incluye un contacto nacido el 29/02; y `go test -tags integration ./services/segments/internal/compiler/...` sigue en verde.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Extensión acotada del compilador con un caso borde conocido; standard.
- **Dependencies**: F3.2.T4
- **Files**:
  - `contracts/dsl/segment.schema.json`
  - `contracts/dsl/fixtures/segments/anniversary-birthday.json`
  - `contracts/dsl/fixtures/segments/invalid-anniversary-text.json`
  - `services/segments/internal/compiler/date.go`
  - `services/segments/internal/compiler/date_test.go`
  - `services/segments/internal/compiler/criteria.go`
  - `services/segments/internal/compiler/testdata/golden/`

## F3.3 — Package: segments service

### F3.3.T1 — Scaffold del servicio Go segments

Crear el módulo Go `services/segments`, agregarlo a `go.work`, y escribir un Dockerfile distroless y `cmd/segments/main.go`, que arranca config (`SEGMENTS_HTTP_ADDR`, `SEGMENTS_GRPC_ADDR`, `PG_DSN`, `CLICKHOUSE_DSN`, `NATS_URL`, `JWKS_URL`), logger y OTel de `libs/go/oe`, con `/healthz`. `main.go` expone la función `run(ctx, deps)` donde F3.5.T2 registra API, scheduler y gRPC; esta tarea no registra rutas de negocio.

Done when: `go build ./services/segments/...` y `docker build -f services/segments/Dockerfile .` pasan, y `/healthz` responde 200.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 1.5h
- **Reason**: Boilerplate de scaffold con el patrón de F2.3.T1.
- **Dependencies**: F2.8.T1
- **Files**:
  - `services/segments/go.mod`
  - `services/segments/go.sum`
  - `go.work`
  - `services/segments/Dockerfile`
  - `services/segments/cmd/segments/main.go`
  - `services/segments/internal/config/config.go`

### F3.3.T2 — Schema Postgres y store de segmentos

Migraciones SQL del schema `segments` (sección *PostgreSQL*): `segments(id, tenant_id, name, definition jsonb, version, created_by, created_at, updated_at, deleted_at)`, `runs(id, tenant_id, segment_id, started_at, finished_at, count, status, error)` y `schedules(tenant_id, segment_id pk, cron, next_run_at)`, con RLS `tenant_id = current_setting('app.tenant_id')` y el rol `segments` con acceso solo a su schema. Runner de migraciones con `golang-migrate` embebido. Paquete `internal/store`: CRUD de segmentos (cada update incrementa `version`), runs (crear, cerrar, listar últimos N) y schedules (upsert, `DueSchedules(now, limit)` con `FOR UPDATE SKIP LOCKED`), todo dentro de transacciones con `SET LOCAL app.tenant_id` (usar `libs/go/oe/pg`). Cubre FR-25, NFR-8.

Done when: `go test -tags integration ./services/segments/internal/store/...` (Postgres de testcontainers) pasa con CRUD, versión incrementada, `DueSchedules` sin doble entrega entre dos transacciones concurrentes, y lectura con `app.tenant_id` de otro tenant que devuelve cero filas.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Persistencia con RLS usando helpers ya existentes; estándar.
- **Dependencies**: F3.3.T1
- **Files**:
  - `services/segments/migrations/`
  - `services/segments/internal/store/`

### F3.3.T3 — API REST admin y pública de segmentos

Implementar `internal/api` según `contracts/openapi/admin-v1/segments.yaml` y la sección `filter` de `public-v3.yaml`:
- **Admin** (JWT de usuario, permisos `segments:view|edit`, errores problem+json): CRUD, validación de la definición con el compilador al guardar, y `POST /admin/v1/segments/count` para definiciones ad hoc, con timeout de 10 s y `count()` sobre el SQL compilado.
- **Pública** (JWT `typ=client`, scope `segments:read`, envelope `replyCode`): listar, contar y paginar contactos. La paginación usa la última ejecución materializada (`segment_members`, `ORDER BY contact_id LIMIT/OFFSET`) y, si no existe, materializa antes. Devuelve los contactos con los campos de sistema pedidos vía core `POST /internal/v1/contacts/lookup` (C4).

Handlers como constructor `api.New(deps) http.Handler`, sin registrarse en main. Cubre FR-22, FR-23, FR-24, FR-26, NFR-8.

Done when: `go test ./services/segments/internal/api/...` pasa con: guardar una definición inválida → 422 con el código del compilador, count ad hoc sobre ClickHouse de testcontainers, suma de páginas igual al conteo con 25.000 miembros (FR-26), y token de otro tenant → 404 sobre un segmento ajeno.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Endpoints con dos estilos de contrato y paginación; estándar.
- **Dependencies**: F3.3.T2, F3.2.T1, F3.1.T2
- **Files**:
  - `services/segments/internal/api/`

### F3.3.T4 — Materialización, ejecuciones e historial

Implementar `internal/materialize`: `Run(ctx, tenantID, segmentID) (runID, count, error)` crea un run, ejecuta `INSERT INTO oe.segment_members SELECT {t}, {segment}, {run}, contact_id FROM (<compiled>)`, cuenta, cierra el run y publica `segments.run.completed` (C1). Migración ClickHouse `0301_segment_members.sql` (`MergeTree`, `ORDER BY (tenant_id, segment_id, run_id, contact_id)`, TTL de 30 días para runs viejos). Conserva siempre la última ejecución exitosa aunque sea más vieja que el TTL (la marca en el store). Si falla, el run queda `failed` con el error. Cubre FR-25 (conteo histórico), FR-26.

Done when: `go test -tags integration ./services/segments/internal/materialize/...` pasa con: run exitoso que inserta N filas y publica un evento con count N, run fallido (SQL roto forzado) marcado `failed` sin evento, e historial con los 3 últimos runs en orden.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Orquestación de SQL y eventos con manejo de fallos; estándar.
- **Dependencies**: F3.3.T2, F3.2.T1, F3.1.T2
- **Files**:
  - `services/segments/internal/materialize/`
  - `deploy/clickhouse/migrations/0301_segment_members.sql`

### F3.3.T5 — Scheduler de ejecuciones

Implementar `internal/scheduler`: un ticker cada 30 s toma el advisory lock de Postgres `pg_try_advisory_lock(hashtext('segments-scheduler'))` (solo una réplica agenda), pide `DueSchedules` y, por cada uno, llama `materialize.Run` con concurrencia máxima configurable (por defecto 4) y recalcula `next_run_at` con `robfig/cron/v3` en la zona horaria del tenant. Si un run falla, igual avanza `next_run_at` y registra una métrica. Apagado ordenado con el contexto. Cubre FR-25.

Done when: `go test ./services/segments/internal/scheduler/...` pasa con reloj falso: un schedule diario vencido se ejecuta una vez y su `next_run_at` avanza 24 h en la zona del tenant; dos schedulers simultáneos no ejecutan dos veces.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Scheduler simple con lock; estándar.
- **Dependencies**: F3.3.T4
- **Files**:
  - `services/segments/internal/scheduler/`

### F3.3.T6 — Servidor gRPC Segments

Implementar `internal/grpc` con el servicio de `proto/segments/v1` (C5). Autenticación por metadata `authorization` con token `typ=service` (interceptor de `libs/go/oe`) y propagación de `traceparent`.
- `Count` compila y cuenta, igual que la API.
- `IsMember` compila la definición (o la carga por `segment_id`) agregando `AND contact_id = {c}` con `LIMIT 1`. Caché LRU de SQL compilado por `(tenant, segment_id, version)`. Objetivo p99 < 30 ms para el engine de F5.
- `Materialize` delega en `materialize.Run`.

Constructor `grpc.New(deps) *grpc.Server`. Cubre FR-23, y la base de FR-41 (F5) y de campaigns (F4).

Done when: `go test ./services/segments/internal/grpc/...` pasa con bufconn: token sin `typ=service` → `Unauthenticated`, `IsMember` true/false correcto contra ClickHouse de testcontainers, y un segundo `IsMember` del mismo segmento que no recompila (contador de caché).

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Servidor gRPC con interceptores ya existentes; estándar.
- **Dependencies**: F3.3.T4, F3.1.T2
- **Files**:
  - `services/segments/internal/grpc/`

## F3.4 — Package: admin-web segment builder

### F3.4.T1 — Componente builder de segmentos

Crear `src/components/segment-builder` para editar el DSL de C6 como árbol: grupos `and/or/not` anidables hasta profundidad 5 (agregar, quitar, cambiar operador) y editores por kind:
- `field`: selector de campo con los tipos de F1 y operadores válidos por tipo.
- `list` y `segment`: selectores con búsqueda.
- `behavior`: tipo de evento, incluidos los External Events de F2, ventana, conteo y condiciones sobre props.
- `message`: canal, acción, ventana y campaña opcional.
- `relational`: tabla, columna, operador y valor.

Los kinds `score` y `loyalty` aparecen deshabilitados con el aviso "disponible en F6/F9". El estado se valida con zod generado desde `contracts/dsl/segment.schema.json`, y el componente emite siempre JSON válido contra el schema. Todo operable con teclado y lectores de pantalla (roles tree/group, NFR-15). Textos en `messages/*/segments.json`. Estructura fija, porque F6, F9 y F10 la extienden: un editor por kind en `criteria/<kind>.tsx`, registrados en `criteria/index.ts`, y un punto de extensión vacío `ai-slot.tsx` montado arriba del árbol. Cubre FR-22, FR-24, NFR-15, NFR-16.

Done when: `pnpm --filter admin-web test -- segment-builder` pasa: armar el ejemplo de FR-22 solo con interacciones de teclado produce exactamente la fixture correspondiente de `contracts/dsl/fixtures/segments/`, no se puede anidar un sexto nivel, y axe no reporta violaciones.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Componente de UI complejo pero sin decisiones de arquitectura; estándar.
- **Dependencies**: F3.1.T2
- **Files**:
  - `apps/admin-web/src/components/segment-builder/`
  - `apps/admin-web/messages/es/segments.json`
  - `apps/admin-web/messages/pt/segments.json`
  - `apps/admin-web/messages/en/segments.json`

### F3.4.T2 — Páginas de segmentos: listado, edición con conteo en vivo e historial

Crear la feature `segments` (C11): listado con tamaño de la última ejecución y agenda; página de edición con el builder de F3.4.T1 y el conteo estimado vía `POST /admin/v1/segments/count`, con debounce de 600 ms, cancelación de la request anterior (AbortController), indicador de carga y tiempo de respuesta; guardado; agenda (presets diario, semanal o cron) y "ejecutar ahora"; historial con gráfico de tamaño de los últimos 30 días (FR-25) desde `/runs`. Entrada de navegación en `src/nav/segments.ts` con permiso `segments:view`. Cubre FR-22, FR-23, FR-25, NFR-15.

Done when: `pnpm --filter admin-web test -- segments` (msw) pasa: tres cambios rápidos del builder generan una sola request de conteo efectiva, el historial dibuja 30 puntos y guardar muestra el toast de confirmación; `pnpm --filter admin-web build` pasa.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Páginas de consola sobre un componente ya hecho; estándar.
- **Dependencies**: F3.4.T1
- **Files**:
  - `apps/admin-web/src/app/[locale]/(console)/segments/`
  - `apps/admin-web/src/nav/segments.ts`

## F3.5 — Package: bench y e2e F3

### F3.5.T1 — Cierre de fase F3: e2e de segmentación y NFR-5

Gate de la fase. Con la stack completa y el seed de comportamiento escalado a 1 M de contactos y 100 M de eventos (`SEED_SCALE=10`), correr y registrar en `tests/e2e/segments/`:
1. **FR-22:** crear en admin-web (Playwright) el segmento "compró en 30 días Y NO abrió emails en 60" y comparar su conteo con una consulta de verificación independiente escrita a mano en SQL.
2. **FR-23 y NFR-5:** medir el conteo en vivo con 5 criterios mixtos, con el bench de F3.5.T3; p50/p95/p99 en `RESULTS.md`, y p99 < 5 s.
3. **FR-24:** "A menos B" igual a |A| − |A∩B|.
4. **FR-25:** agendar diario, forzar dos ejecuciones y ver dos puntos en el historial.
5. **FR-26:** paginar por API pública y comprobar que la suma de páginas es igual al conteo.
6. **NFR-8:** token de otro tenant sobre `/api/v3/filter/{id}` y gRPC `IsMember` con `tenant_id` ajeno → sin datos.

Cubre FR-22 a FR-26, NFR-5, NFR-8.

Done when: `pnpm --filter e2e test -- segments` pasa en verde y `tests/e2e/segments/RESULTS.md` muestra p99 < 5 s sobre 1 M de contactos y 100 M de eventos.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Verificación de punta a punta con datos a escala; estándar.
- **Dependencies**: F3.5.T2, F3.5.T3, F3.4.T2
- **Files**:
  - `tests/e2e/segments/`

### F3.5.T2 — Wiring de F3: main, compose y gateway

Registrar en `services/segments/cmd/segments/main.go` la API (F3.3.T3), el scheduler (F3.3.T5) y el servidor gRPC (F3.3.T6), con apagado ordenado de los tres. Crear `deploy/compose/services/segments.yml` (perfil `data`, puertos HTTP y gRPC internos, healthcheck, migraciones Postgres al arrancar, rol `segments`) e incluirlo desde `deploy/compose/docker-compose.yml`. Sumar las migraciones ClickHouse 03xx al job de migraciones. Crear `deploy/traefik/dynamic/segments.yml`, que enruta `/admin/v1/segments*` y `/api/v3/filter*` a segments. Cubre la integración de FR-22 a FR-26.

Done when: `docker compose --profile core --profile data up -d` levanta segments healthy, `curl` a `/admin/v1/segments` con un JWT del seed devuelve 200, y `grpcurl -plaintext segments:9090 list` (desde la red interna) muestra `segments.v1.Segments`.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Configuración e integración; estándar.
- **Dependencies**: F3.3.T3, F3.3.T5, F3.3.T6, F3.2.T5
- **Files**:
  - `services/segments/cmd/segments/main.go`
  - `deploy/compose/services/segments.yml`
  - `deploy/compose/docker-compose.yml`
  - `deploy/traefik/dynamic/segments.yml`

### F3.5.T3 — Benchmark de segmentación NFR-5

Escribir `scripts/bench/segments/bench.go` (un único archivo `package main` solo con stdlib, sin módulo nuevo ni cambios en `go.work`) que carga 20 definiciones representativas de `scripts/bench/segments/definitions/` (de 1 a 5 criterios mixtos de perfil, comportamiento, mensajes, listas y relacionales) y corre cada una 30 veces contra `POST /admin/v1/segments/count`. Reporta p50/p95/p99 por definición y total en tabla Markdown, y sale con código ≠ 0 si el p99 de las definiciones de 5 criterios supera 5 s. `README.md` con el procedimiento de seed a escala y el host de referencia (8 vCPU/16 GB). Cubre NFR-5, FR-23.

Done when: `go vet scripts/bench/segments/bench.go` pasa y `go run scripts/bench/segments/bench.go -runs 1 -url ...` contra la stack local con `SEED_SCALE=0.01` imprime la tabla de resultados.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 2h
- **Reason**: Herramienta de medición simple.
- **Dependencies**: F3.1.T1
- **Files**:
  - `scripts/bench/segments/bench.go`
  - `scripts/bench/segments/definitions/`
  - `scripts/bench/segments/README.md`
