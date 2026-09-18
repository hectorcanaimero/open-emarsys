---
type: spec
project_id: open-emarsys
phase: 1
version: 0.1
depends_on:
  - docs/arch/001-open-emarsys.md
  - docs/prd/001-open-emarsys.md
consumed_by:
  - orch-atomizer
generated_by: orch-spec
generated_at: 2026-09-17
title: Base de contactos
---

# F1 — Base de contactos

Milestone M1 del PRD: campos con field IDs estables, API de contactos compatible en forma con Emarsys (A1), búsqueda y ficha, import/export masivo, listas, consentimiento por canal, GDPR y datos relacionales. Cubre FR-7..FR-16 y aplica NFR-8, NFR-10, NFR-14, NFR-15 y NFR-16. Referencia obligatoria: `docs/arch/001-open-emarsys.md` (Data model → core → contacts, Interfaces C1, C2, C3, C4 y C11).

## F1.1 — Package: contracts contactos

### F1.1.T1 — Field IDs de sistema y eventos de contactos

- `contracts/dsl/system-fields.json`: catálogo de campos de sistema con field IDs fijos 1–99 (*Data model → contacts*): como mínimo `1` first_name, `2` last_name, `3` email (único), `4` external_id (único), `5` phone, `6` birth_date, `7` gender (single choice con IDs de opción), `8` city, `9` country (ISO 3166-1 alpha-2), `10` zip, `11` language, `12` timezone, `13` company, `31` optin_email, `32` optin_sms, `33` optin_push (single choice `1`=sí, `2`=no, vacío=desconocido), `40` created_at y `41` updated_at (solo lectura). Cada entrada: `field_id`, `api_name`, `type` (`text|number|date|boolean|single_choice|multi_choice`), `unique`, `read_only`, `choices[{id, api_name, labels{es,pt,en}}]`, `labels{es,pt,en}`. Los custom empiezan en 1000.
- Eventos (C1): `contracts/events/contacts.upserted.schema.json` (`data: {version, fields{"<fieldId>": valor}, changed["<fieldId>"], lists[uuid]}` con `fields` completo del contacto), `contracts/events/contacts.deleted.schema.json` (`data: {reason: "gdpr"|"api"}`), `contracts/events/consent.changed.schema.json` (`data: {channel: "email"|"sms"|"push", value: 1|2|null, source, text}`), cada uno con su ejemplo en `contracts/events/examples/`.

Cubre FR-7 y FR-14 (contratos).

Done when: `make contracts` valida los tres schemas con sus ejemplos y `system-fields.json` contra un schema propio incluido en el archivo `contracts/dsl/system-fields.schema.json`.

- **Model**: claude/claude-opus-5
- **Estimate**: 2h
- **Reason**: Contratos base del dominio de contactos que consumen core, importer, sink, segments y dispatcher; conviene no tener que renumerar nunca.
- **Dependencies**: F0.8.T1
- **Files**:
  - `contracts/dsl/system-fields.json`
  - `contracts/dsl/system-fields.schema.json`
  - `contracts/events/contacts.upserted.schema.json`
  - `contracts/events/contacts.deleted.schema.json`
  - `contracts/events/consent.changed.schema.json`
  - `contracts/events/examples/contacts.upserted.json`
  - `contracts/events/examples/contacts.deleted.json`
  - `contracts/events/examples/consent.changed.json`

### F1.1.T2 — API pública v3 de contactos, listas, GDPR y jobs

Agregar a `contracts/openapi/public-v3.yaml` (C2, envelope `{replyCode, replyText, data}`, OAuth client credentials) los paths de F1 con sus scopes requeridos:
- `GET /field` (lista con `id`, `name`, `application_type`), `POST /field` (crea custom), `GET /field/{id}/choice`.
- `PUT /contact` y `POST /contact` con `?create_if_not_exists=1`: body `{key_id: "3", contacts: [{"3": "a@b.com", "1": "Ana"}]}` hasta 1.000; respuesta `data: {ids: [...], errors: [{index, key, code, text}]}` (éxito parcial, FR-8).
- `POST /contact/delete` (`{key_id, contacts: [{"<key_id>": valor}]}`).
- `POST /contact/getdata`: `{keyId, keyValues[], fields[]}` → `data: {result: [{"id", "<fieldId>": valor}], errors}` (FR-9).
- `GET /contactlist`, `POST /contactlist` (`{name, key_id, external_ids[]}`), `POST /contactlist/{id}/add` y `/delete` (`{key_id, external_ids[]}`), `GET /contactlist/{id}/count`.
- `POST /contact/consent` (`{key_id, key_value, channel, value, source, text}`).
- `POST /gdpr/export` y `POST /gdpr/forget` (`{key_id, key_value}` → `JobAccepted`).
- `POST /import` (multipart `file` + `mapping{columna: fieldId}`, `key_id`, `mode: create|update|upsert`, `target: contacts|list:<id>|relational:<tableId>`) → `JobAccepted`; `POST /export` (`{fields[], scope: all|list:<id>, format: csv}`) → `JobAccepted`. `GET /jobs/{id}` ya existe (F0).
- `PUT /relational/{tableId}/rows` (`{key_id, rows: [{key_value, row_key, data{}}]}`).

Códigos `replyCode` de negocio documentados en una tabla del `info.description` (ej. 2008 contacto no encontrado, 2009 key_id inválido, 2010 valor inválido para el tipo del campo, 2011 campo no existe).

Cubre FR-7, FR-8, FR-9, FR-11, FR-12, FR-13, FR-14, FR-15, FR-16 (contratos).

Done when: `make contracts` valida `public-v3.yaml` y `make codegen` genera tipos TS sin errores.

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Diseño de la API pública que replica la forma de Emarsys (A1); cambios posteriores rompen clientes y fixtures.
- **Dependencies**: F0.8.T1
- **Files**:
  - `contracts/openapi/public-v3.yaml`

### F1.1.T3 — API admin de contactos, API admin de importer y API interna de core

Tres documentos OpenAPI 3.1:
1. `contracts/openapi/admin-v1/contacts.yaml` (C3, JSON plano, problem+json, cursor): `GET/POST /fields`, `PATCH/DELETE /fields/{fieldId}` (renombrar no cambia el ID; borrar solo custom sin uso en listas), `GET /contacts?q=&cursor&limit&filters` (búsqueda por email, nombre, external_id y filtros simples por campo), `GET/PATCH/DELETE /contacts/{id}`, `GET /contacts/{id}/consents` (historial), `POST /contacts/{id}/consents`, `GET /contacts/{id}/lists`, `GET/POST /lists`, `GET/PATCH/DELETE /lists/{id}`, `GET /lists/{id}/members`, `POST /lists/{id}/members` y `DELETE /lists/{id}/members` (por `contact_ids[]`), `GET/POST /relational-tables`, `GET/PATCH/DELETE /relational-tables/{id}`, `GET /contacts/{id}/relational/{tableId}`, `POST /contacts/{id}/gdpr/export`, `POST /contacts/{id}/gdpr/forget`, `GET /gdpr-requests`. Permisos `contacts:view|edit|admin` por operación.
2. `contracts/openapi/admin-v1/importer.yaml`: `POST /imports` (crea job; subida por URL prefirmada de MinIO: `POST /imports/upload-url` → `{url, object_key}`), `POST /imports/{id}/preview` (primeras 20 filas y columnas detectadas), `POST /imports/{id}/start` (mapping, key_id, mode, target), `GET /jobs?kind&cursor`, `GET /jobs/{id}` (progreso, `result_url`, `error_report_url` firmados con expiración), `POST /exports`.
3. `contracts/openapi/internal/core.yaml` (C4, token `typ=service`): `POST /internal/v1/contacts/batch-upsert` (`{tenant_id, key_id, mode, contacts[]}` → `{results[{index, id, created, error?}]}`), `POST /internal/v1/contacts/lookup` (`{tenant_id, contact_ids[], field_ids[]}` → mapa), `GET /internal/v1/contacts/stream?tenant_id&fields=&list_id=` (NDJSON, un contacto por línea), `POST /internal/v1/contacts/{id}/fields`, `POST /internal/v1/lists/{id}/members` (`{tenant_id, key_id, key_values[]}`), `POST /internal/v1/relational/{tableId}/rows`.

Cubre FR-7, FR-10, FR-11, FR-12, FR-13, FR-14, FR-15, FR-16 (contratos).

Done when: `make contracts` valida los tres archivos y `make codegen` genera `packages/ts-contracts/src/gen/openapi/contacts.ts` e `importer.ts`.

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Contratos entre core, importer y admin-web que permiten construir esos paquetes en paralelo sin hablar entre sí.
- **Dependencies**: F0.8.T1
- **Files**:
  - `contracts/openapi/admin-v1/contacts.yaml`
  - `contracts/openapi/admin-v1/importer.yaml`
  - `contracts/openapi/internal/core.yaml`

## F1.2 — Package: core contacts module

### F1.2.T1 — Esquema contacts con RLS e índices

`services/core/prisma/schema/contacts.prisma` en el schema `contacts` con las tablas de *Data model → core → contacts*: `field_definitions`, `contacts`, `unique_values`, `lists`, `list_members`, `consents`, `gdpr_requests` e `identity_links`. Migración con SQL manual para lo que Prisma no expresa: RLS + `FORCE ROW LEVEL SECURITY` con la política estándar en todas las tablas; columna generada `email_norm text GENERATED ALWAYS AS (lower(trim(data->>'3'))) STORED`; `external_id` generada desde `data->>'4'`; índice GIN `jsonb_path_ops` sobre `data`; únicos parciales `(tenant_id, email_norm) WHERE deleted_at IS NULL AND email_norm IS NOT NULL` y lo mismo para `external_id`; único `(tenant_id, field_id, value)` en `unique_values`; índice trigram (`pg_trgm`) en `email_norm` y en `data->>'1'`, `data->>'2'` para la búsqueda; secuencia por tenant para field IDs custom (función `next_custom_field_id(tenant)` que arranca en 1000); `consents` append-only (revocar UPDATE/DELETE). Un seeder de módulo (`src/modules/contacts-shared/system-fields.seeder.ts`) que al crear un tenant (consumidor de `system.tenant.created`) inserta las definiciones de `contracts/dsl/system-fields.json`. Única tarea de F1.2 que edita `services/core/package.json`: agregar `@aws-sdk/client-s3`, `pg-copy-streams` y `ndjson` que usan F1.2.T4 y F1.3.T2. Cubre FR-7, FR-13, FR-14, FR-15, NFR-8.

Done when: `prisma migrate deploy` aplica sobre la base de F0, un test de integración inserta dos contactos con el mismo email en el mismo tenant y falla, en tenants distintos y funciona, y crear un tenant deja los campos de sistema cargados.

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Modelo de datos central del sistema (D5) con índices y RLS que definen rendimiento y aislamiento.
- **Dependencies**: F1.1.T1
- **Files**:
  - `services/core/prisma/schema/contacts.prisma`
  - `services/core/prisma/migrations/`
  - `services/core/src/modules/contacts-shared/`
  - `services/core/package.json`

### F1.2.T2 — Definiciones de campos y resolución de claves

Módulo Nest `services/core/src/modules/fields/` (`FieldsModule`):
- Admin (`contracts/openapi/admin-v1/contacts.yaml`): `GET/POST /admin/v1/fields`, `PATCH/DELETE /admin/v1/fields/{fieldId}`. Crear asigna el siguiente ID custom (≥1000) que nunca cambia al renombrar; `api_name` único por tenant en snake_case; los de sistema no se editan salvo labels; borrar un custom lo marca borrado y elimina su clave del jsonb de forma asíncrona.
- Pública (`contracts/openapi/public-v3.yaml`, envelope): `GET/POST /api/v3/field`, `GET /api/v3/field/{id}/choice`.
- `FieldRegistry` cacheado por tenant (invalidado al cambiar campos) con `validateValue(fieldId, raw)` que normaliza por tipo (fecha ISO `YYYY-MM-DD`, número decimal, boolean, choice por ID de opción, multi choice como array de IDs) y devuelve `replyCode` 2010/2011 en errores.
- `KeyResolver` en `key-resolver.ts`: dado `key_id` y valores, resuelve contact IDs en lote (`email_norm`, `external_id`, `id` interno o un campo custom `unique` vía `unique_values`) con una consulta por lote; rechaza `key_id` no único con 2009.

Cubre FR-7.

Done when: tests de integración verifican alta de campo custom con ID ≥1000, renombrar sin cambio de ID, validación de cada tipo, `key_id` no único rechazado, y `KeyResolver` resolviendo 1.000 emails en una sola consulta (espía sobre el cliente).

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Lógica de validación por tipos y resolución de claves bien acotada por el contrato.
- **Dependencies**: F1.2.T1, F1.1.T2, F1.1.T3
- **Files**:
  - `services/core/src/modules/fields/`

### F1.2.T3 — Escritura de contactos en lote y eventos

Módulo `services/core/src/modules/contacts-write/`:
- Público: `PUT /api/v3/contact`, `POST /api/v3/contact?create_if_not_exists=1`, `POST /api/v3/contact/delete` (C2). Lotes de hasta 1.000; cada ítem se valida con `FieldRegistry` y se resuelve con `KeyResolver`; los válidos se escriben en una transacción por lote con `INSERT ... ON CONFLICT` sobre los únicos parciales, actualización de `unique_values` y `version = version + 1`; los inválidos vuelven en `data.errors[{index, key, code, text}]` sin abortar el lote (FR-8). Campos `read_only` ignorados con error por ítem. Merge de jsonb: solo cambia las claves enviadas; valor `null` borra la clave.
- Admin: `PATCH /admin/v1/contacts/{id}`, `DELETE /admin/v1/contacts/{id}` (soft delete con `deleted_at`), con auditoría vía `AuditInterceptor`.
- Interno (C4): `POST /internal/v1/contacts/batch-upsert` (mismo motor, `tenant_id` del body validado contra el token de servicio) y `POST /internal/v1/contacts/{id}/fields`.
- Eventos (C1): por cada contacto creado o modificado, `contacts.upserted` con los `fields` completos y `changed`; por cada borrado, `contacts.deleted` (`reason: api`). Publicación después del commit (patrón outbox simple: tabla `contacts.outbox` escrita en la misma transacción y un publisher que la drena, para no perder eventos si NATS cae; agregar la tabla con una migración propia).

Cubre FR-8, NFR-11.

Done when: tests de integración verifican el lote de 998 válidos + 2 inválidos (persisten 998, 2 errores por posición), que un update solo cambia las claves enviadas y sube `version`, que `null` borra la clave, que cada escritura produce exactamente un `contacts.upserted` aun reiniciando el publisher entre commit y publicación, y que el tenant A no puede escribir un contacto del tenant B por ID.

- **Model**: claude/claude-opus-5
- **Estimate**: 4h
- **Reason**: Camino de escritura principal con éxito parcial, concurrencia sobre únicos y entrega garantizada de eventos.
- **Dependencies**: F1.2.T2
- **Files**:
  - `services/core/src/modules/contacts-write/`
  - `services/core/prisma/schema/outbox.prisma`
  - `services/core/prisma/migrations/`

### F1.2.T4 — Consulta, búsqueda, lookup y stream de contactos

Módulo `services/core/src/modules/contacts-query/` con Kysely (D8) sobre la extensión de tenant:
- Público: `POST /api/v3/contact/getdata` (`keyId`, `keyValues[]`, `fields[]`) → solo los field IDs pedidos, errores por clave no encontrada (2008) (FR-9).
- Admin: `GET /admin/v1/contacts?q=&filters=&cursor&limit` (búsqueda por prefijo de email con trigram, nombre, external_id; filtros `field_id cmp valor` simples; paginación por cursor sobre `(updated_at, id)`), `GET /admin/v1/contacts/{id}` (perfil con labels según locale, consentimientos vigentes, listas) (FR-10).
- Interno (C4): `POST /internal/v1/contacts/lookup` (hasta 5.000 IDs y campos pedidos, una consulta) y `GET /internal/v1/contacts/stream?tenant_id&fields=&list_id=` en NDJSON con cursor de servidor (`DECLARE CURSOR` o `pg-copy-streams`) y backpressure, para exports de 1 M de filas sin cargar todo en memoria (FR-12).

La timeline de eventos de la ficha (FR-10, últimos 50 eventos) llega en F2 (F2.5); en F1 la ficha no la incluye.

Cubre FR-9, FR-10, FR-12.

Done when: tests de integración verifican `getdata` de 3 emails con campos 1 y 3, búsqueda por prefijo de email sobre 100.000 contactos en < 200 ms, y que el stream de 1 M de contactos se consume con memoria del proceso < 300 MB (medido en el test).

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Consultas dinámicas y streaming con requisitos de rendimiento medibles; estándar alto.
- **Dependencies**: F1.2.T2
- **Files**:
  - `services/core/src/modules/contacts-query/`

### F1.2.T5 — Listas de contactos

Módulo `services/core/src/modules/lists/`:
- Público (C2): `GET/POST /api/v3/contactlist`, `POST /api/v3/contactlist/{id}/add` y `/delete` por `key_id` + valores (resueltos con `KeyResolver`, hasta 10.000 por llamada), `GET /api/v3/contactlist/{id}/count`.
- Admin (C3): CRUD de listas, `GET /admin/v1/lists/{id}/members` paginado, `POST/DELETE /admin/v1/lists/{id}/members` por `contact_ids[]`, `GET /admin/v1/contacts/{id}/lists`.
- Interno (C4): `POST /internal/v1/lists/{id}/members` para importer.
- Agregar o quitar miembros publica `contacts.upserted` del contacto con `lists` actualizado, usando el outbox de F1.2.T3 (inyectar su servicio, no duplicarlo).

Cubre FR-13.

Done when: tests de integración verifican que agregar 500 contactos por API deja el conteo en 500, que agregar dos veces el mismo contacto no duplica, que claves no encontradas vuelven como errores sin abortar, y que cada cambio emite el evento con `lists` correcto.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: CRUD con operaciones en lote sobre piezas ya existentes.
- **Dependencies**: F1.2.T3
- **Files**:
  - `services/core/src/modules/lists/`

### F1.2.T6 — Consentimiento por canal

Módulo `services/core/src/modules/consents/`:
- Público: `POST /api/v3/contact/consent` (`key_id`, `key_value`, `channel`, `value`, `source`, `text`). Admin: `GET/POST /admin/v1/contacts/{id}/consents`.
- Cada cambio inserta una fila append-only en `consents` (valor, fecha, origen, texto aceptado, actor) y actualiza el valor vigente en los field IDs 31/32/33 del jsonb a través del servicio de escritura de F1.2.T3 (una sola transacción), publicando `consent.changed` y `contacts.upserted`.
- Escribir directamente los campos 31/32/33 por la API de contactos también genera la fila de historial con `source: "api"` (hook en el servicio de escritura expuesto por F1.2.T3; si no existe el punto de extensión, agregarlo dentro de `consents/` como listener del outbox y no editar `contacts-write/`).
- `GET /admin/v1/contacts/{id}/consents` devuelve el historial por canal ordenado por fecha.

Cubre FR-14, NFR-10.

Done when: tests de integración verifican que tres cambios de opt-in email aparecen en el historial con origen y texto, que el valor vigente del campo 31 coincide con el último, que escribir el campo 31 por `PUT /contact` también deja historial, y que cada cambio publica `consent.changed`.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Reglas claras de auditoría de consentimiento sobre el camino de escritura existente.
- **Dependencies**: F1.2.T3
- **Files**:
  - `services/core/src/modules/consents/`

## F1.3 — Package: core gdpr y relational

### F1.3.T1 — Tablas de datos relacionales

`services/core/prisma/schema/relational.prisma` (tablas `relational_tables` y `relational_rows` del arch, con RLS, único `(table_id, contact_id, key)`, GIN sobre `data`) con su migración, y módulo `services/core/src/modules/relational/`:
- Admin: `GET/POST /admin/v1/relational-tables` (nombre, `key_field`, `columns[{name, type}]` con los mismos tipos que los campos), `PATCH/DELETE /admin/v1/relational-tables/{id}` (agregar columnas; borrar tabla borra filas), `GET /admin/v1/contacts/{id}/relational/{tableId}`.
- Público: `PUT /api/v3/relational/{tableId}/rows` con `key_id` del contacto (resuelto con `KeyResolver`), `row_key` y `data` validado por tipo de columna; éxito parcial con errores por ítem.
- Interno: `POST /internal/v1/relational/{tableId}/rows` para importer.
- No publica eventos en F1: el evento de filas relacionales para la réplica de ClickHouse lo agrega F3.2.T2.

El filtro "contactos con una mascota de especie perro" de FR-16 se evalúa en F3 (segments sobre `relational_replica`); aquí queda el dato y la consulta por contacto.

Cubre FR-16.

Done when: tests de integración verifican crear la tabla "mascotas" con columna `especie`, cargar 3 filas para un contacto por API pública, leerlas en la ficha y rechazar un valor de tipo inválido.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Modelo genérico de tablas por tenant; estándar con validación reutilizada.
- **Dependencies**: F1.2.T2, F1.2.T3
- **Files**:
  - `services/core/prisma/schema/relational.prisma`
  - `services/core/prisma/migrations/`
  - `services/core/src/modules/relational/`

### F1.3.T2 — Derechos GDPR: acceso y olvido

Módulo `services/core/src/modules/gdpr/`:
- Público `POST /api/v3/gdpr/export` y `/forget`; admin `POST /admin/v1/contacts/{id}/gdpr/export` y `/forget` (requiere `contacts:admin`, doble confirmación en UI), `GET /admin/v1/gdpr-requests`. Cada solicitud crea una fila en `gdpr_requests` y se procesa en segundo plano (BullMQ interno de core, A3).
- Export (acceso): arma un JSON con perfil completo con labels, historial de consentimientos, listas, filas relacionales y auditoría relacionada al contacto; lo sube al bucket `exports` de MinIO y devuelve URL prefirmada que expira en 24 h. Deja el punto de extensión `GdprExportContributor` para que F2 agregue eventos de ClickHouse.
- Olvido: en una transacción borra físicamente la fila de `contacts`, `unique_values`, `list_members`, `relational_rows` e `identity_links` del contacto; anonimiza el `text` de sus `consents` conservando fecha y valor como prueba legal sin datos personales; registra la solicitud con un hash del identificador (no el email); publica `contacts.deleted` con `reason: gdpr` (que en F2 el sink usa para anonimizar eventos en ClickHouse y en F6 excluye al contacto del reentrenamiento, NFR-10).
- Tras el olvido, búsqueda, `getdata`, listas y stream no devuelven el contacto.

Cubre FR-15, NFR-10.

Done when: tests de integración verifican que el export contiene perfil, consentimientos, listas y filas relacionales y la URL expira; y que tras el olvido ninguna ruta de búsqueda, `getdata`, miembros de lista ni stream devuelve el contacto, el historial de consentimientos no contiene datos personales y se publicó `contacts.deleted` con `reason: gdpr`.

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Borrado irreversible con obligaciones legales; un error deja datos personales o borra de más.
- **Dependencies**: F1.2.T3, F1.2.T4, F1.3.T1
- **Files**:
  - `services/core/src/modules/gdpr/`

## F1.4 — Package: importer

### F1.4.T1 — Scaffold del servicio importer y cola de jobs

Crear `services/importer` (módulo Go propio, agregado a `go.work`; única tarea de F1.4 que edita `go.mod`/`go.sum`: declarar ya `minio-go/v7` y lo que usen T2 y T3, fijado con `deps.go`). Con `libs/go/oe`: `cmd/importer/main.go` (config, OTel, servidor `httpx`, auth `Require`), migración embebida del schema `importer` con la tabla `jobs` del arch (RLS con `InTenantTx`), cola de jobs en Postgres (`SELECT ... FOR UPDATE SKIP LOCKED`, N workers configurables, reintento de jobs huérfanos al arrancar), progreso persistido cada 5 s, cliente MinIO con URLs prefirmadas y cliente del API interna de core (`contracts/openapi/internal/core.yaml`) con `ServiceTokenSource`. Rutas: `GET /api/v3/jobs/{id}` (envelope C2), `GET /admin/v1/jobs` y `GET /admin/v1/jobs/{id}` (C3). Crear `internal/imports/routes.go` e `internal/exports/routes.go` con handlers stub que responden 501, registrados desde `main.go`, para que F1.4.T2 y F1.4.T3 los reemplacen sin tocar `main.go`. `Dockerfile` y `deploy/compose/services/importer.yml` (perfil `core`). Cubre FR-11, FR-12 (infraestructura), NFR-8.

Done when: `go test ./...` en `services/importer` pasa con un test de integración que encola un job de prueba, lo procesa un worker, se reintenta al simular caída del worker y un tenant no puede consultar el job de otro.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Servicio Go con cola en Postgres sobre librerías existentes; estándar.
- **Dependencies**: F1.1.T2, F1.1.T3
- **Files**:
  - `go.work`
  - `services/importer/go.mod`
  - `services/importer/go.sum`
  - `services/importer/deps.go`
  - `services/importer/cmd/`
  - `services/importer/internal/jobs/`
  - `services/importer/internal/coreclient/`
  - `services/importer/internal/storage/`
  - `services/importer/internal/imports/routes.go`
  - `services/importer/internal/exports/routes.go`
  - `services/importer/migrations/`
  - `services/importer/Dockerfile`
  - `deploy/compose/services/importer.yml`

### F1.4.T2 — Import CSV en streaming

Reemplazar el stub de `internal/imports/routes.go` e implementar en `services/importer/internal/imports/`:
- `POST /admin/v1/imports/upload-url` (URL prefirmada de subida al bucket `imports`), `POST /admin/v1/imports` + `/{id}/preview` (detecta delimitador, encoding UTF-8/Latin-1 y primeras 20 filas) + `/{id}/start`; `POST /api/v3/import` (multipart) según los contratos de F1.1.
- Procesamiento en streaming desde MinIO con `encoding/csv` (sin cargar el archivo en memoria): aplica el mapping columna→field ID, arma lotes de 1.000 y llama a `batch-upsert` (target `contacts`, con `mode`), a `lists/{id}/members` (target `list:<id>`) o a `relational/{tableId}/rows` (target `relational:<id>`); hasta 4 lotes concurrentes por job con límite por tenant; reintentos con backoff ante 5xx de core.
- Errores por fila (validación local de columnas y errores devueltos por core) se escriben en streaming a un CSV `errors.csv` en MinIO (fila original + número de fila + motivo) y quedan en `error_report_url` firmada.
- Progreso (`rows_read`, `rows_ok`, `rows_failed`) y cancelación del job.

Cubre FR-11, FR-13, FR-16.

Done when: un test de integración con core simulado (servidor HTTP de prueba que valida el contrato interno) importa un CSV de 1 M de filas con 1.000 filas inválidas intercaladas: el job termina solo, `rows_ok = 999.000`, el reporte lista las 1.000 filas con motivo, y el proceso no supera 150 MB de memoria.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Streaming y concurrencia acotada en Go con criterios medibles; estándar alto.
- **Dependencies**: F1.4.T1
- **Files**:
  - `services/importer/internal/imports/`

### F1.4.T3 — Export de contactos a MinIO

Reemplazar el stub de `internal/exports/routes.go` e implementar en `services/importer/internal/exports/`: `POST /admin/v1/exports` y `POST /api/v3/export` (`fields[]`, `scope: all|list:<id>`, `format: csv`) → job; el worker consume `GET /internal/v1/contacts/stream` de core en NDJSON y escribe un CSV (cabecera con `api_name` de cada campo, valores de choice por label en el idioma del tenant) en streaming con multipart upload al bucket `exports`, con `result_url` prefirmada que expira en 24 h (configurable) y un aviso al terminar publicado como `system.job.completed` (schema `contracts/events/system.job.completed.schema.json` + ejemplo) que la consola muestra. El scope `segment:<id>` se agrega en F3. Cubre FR-12.

**Ampliación (bloqueo del 2026-09-18):** el CSV lleva el `api_name` de cada campo en la cabecera y los valores de opción como su etiqueta en el `default_locale` del tenant, pero el stream de core solo da `{id, fields}` con ids. Esta tarea añade primero en `contracts/openapi/internal/core.yaml` y en `services/core/src/modules/fields/` un endpoint interno (token de servicio, `/internal/v1`) que devuelve, por tenant, los campos con `api_name`, tipo y etiquetas de opción por idioma, más el `default_locale` del tenant. También cablea NATS en el importer para publicar `system.job.completed`: `natsx` en `services/importer/go.mod`, la conexión en `cmd/importer/main.go` y el cliente en `internal/jobs/env.go`.

Done when: un test de integración con core simulado exporta 1 M de contactos a MinIO en streaming (memoria < 150 MB), la URL descarga el CSV completo y deja de funcionar al vencer (expiración de 1 s en el test), y se publica `system.job.completed`.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Pipeline de streaming simple entre dos contratos ya definidos.
- **Dependencies**: F1.4.T1
- **Files**:
  - `services/importer/internal/exports/`
  - `contracts/events/system.job.completed.schema.json`
  - `contracts/events/examples/system.job.completed.json`
  - `contracts/openapi/internal/core.yaml`
  - `services/core/src/modules/fields/`
  - `services/importer/go.mod`
  - `services/importer/cmd/importer/main.go`
  - `services/importer/internal/jobs/env.go`

## F1.5 — Package: admin-web contactos

### F1.5.T1 — Gestor de campos y navegación de contactos

- `src/nav/contacts.ts` con todos los ítems de la sección (Contactos, Campos, Listas, Importar, Exportaciones, Datos relacionales) y sus permisos. Única tarea de F1.5 que edita `apps/admin-web/package.json`: agregar `papaparse` (preview local de CSV) y `@tanstack/react-virtual`.
- `src/app/[locale]/(console)/contacts/fields/`: tabla de campos (sistema y custom) con field ID visible y copiable, tipo, único, labels en es/pt/en; alta y edición de custom con editor de opciones para choice (cada opción con su ID); borrado con confirmación y aviso de uso.
- Convención de mensajes (C11, por subfeature para evitar conflictos entre tareas paralelas): `messages/<locale>/contacts-fields.json`.

Cubre FR-7, NFR-15, NFR-16.

Done when: tests de componentes con MSW verifican crear un campo single choice con 3 opciones, renombrarlo manteniendo el ID mostrado, y ausencia de violaciones axe; el sidebar muestra la sección solo con `contacts:view`.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: UI CRUD estándar sobre contrato fijo.
- **Dependencies**: F1.1.T3
- **Files**:
  - `apps/admin-web/package.json`
  - `apps/admin-web/src/nav/contacts.ts`
  - `apps/admin-web/src/app/[locale]/(console)/contacts/fields/`
  - `apps/admin-web/messages/es/contacts-fields.json`
  - `apps/admin-web/messages/pt/contacts-fields.json`
  - `apps/admin-web/messages/en/contacts-fields.json`

### F1.5.T2 — Búsqueda y ficha del contacto

- `src/app/[locale]/(console)/contacts/page.tsx` (+ componentes locales): búsqueda con debounce por email, nombre o external_id, filtros simples por campo, tabla virtualizada con paginación por cursor, alta rápida de contacto.
- `src/app/[locale]/(console)/contacts/[id]/`: ficha con perfil editable agrupado (sistema/custom), valores formateados según locale y zona horaria del usuario (NFR-16), panel de consentimientos por canal con historial (valor, fecha, origen, texto) y acción para cambiar consentimiento con texto obligatorio, listas a las que pertenece, y un contenedor vacío `data-slot="timeline"` documentado para que F2.7 inserte la timeline.
- Mensajes en `messages/<locale>/contacts-detail.json`.

Cubre FR-10, FR-14, NFR-15, NFR-16.

Done when: tests de componentes con MSW verifican buscar por email y abrir la ficha, editar un campo de fecha, registrar un cambio de consentimiento que aparece en el historial, y ausencia de violaciones axe en ambas páginas.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Pantallas con varios paneles y formularios dinámicos por tipo de campo; estándar.
- **Dependencies**: F1.1.T3
- **Files**:
  - `apps/admin-web/src/app/[locale]/(console)/contacts/page.tsx`
  - `apps/admin-web/src/app/[locale]/(console)/contacts/_components/`
  - `apps/admin-web/src/app/[locale]/(console)/contacts/[id]/`
  - `apps/admin-web/messages/es/contacts-detail.json`
  - `apps/admin-web/messages/pt/contacts-detail.json`
  - `apps/admin-web/messages/en/contacts-detail.json`

### F1.5.T3 — Listas

`src/app/[locale]/(console)/contacts/lists/`: listado con conteo, crear, renombrar y borrar con confirmación; detalle con miembros paginados, agregar contactos buscándolos y quitar miembros seleccionados; atajo "importar a esta lista" que lleva al asistente de import con `target=list:<id>` precargado por query string. Mensajes en `messages/<locale>/contacts-lists.json`. Cubre FR-13, NFR-15.

Done when: tests de componentes con MSW verifican crear una lista, agregar y quitar miembros y ver el conteo actualizado, sin violaciones axe.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: CRUD simple de listas.
- **Dependencies**: F1.1.T3
- **Files**:
  - `apps/admin-web/src/app/[locale]/(console)/contacts/lists/`
  - `apps/admin-web/messages/es/contacts-lists.json`
  - `apps/admin-web/messages/pt/contacts-lists.json`
  - `apps/admin-web/messages/en/contacts-lists.json`

### F1.5.T4 — Asistente de import, exportaciones y jobs

- `src/app/[locale]/(console)/contacts/import/`: asistente en pasos accesibles (subida directa a MinIO con la URL prefirmada y barra de progreso; preview local con papaparse y preview del servidor; mapeo columna→campo con sugerencia por `api_name`/label y opción "ignorar"; `key_id`, modo y destino contactos/lista/tabla relacional; confirmación) y vista del job con progreso en vivo (polling cada 2 s), resultado y descarga del reporte de errores.
- `src/app/[locale]/(console)/contacts/exports/`: crear export eligiendo campos y alcance (todos/lista), historial de jobs de import y export con estado y enlace de descarga mientras no expire.
- Mensajes en `messages/<locale>/contacts-import.json`.

Cubre FR-11, FR-12, NFR-15.

Done when: tests de componentes con MSW recorren el asistente completo con un CSV de ejemplo hasta un job terminado con 2 errores descargables, y crean un export que muestra el enlace; sin violaciones axe.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Flujo de varios pasos con subida y polling; estándar.
- **Dependencies**: F1.1.T3
- **Files**:
  - `apps/admin-web/src/app/[locale]/(console)/contacts/import/`
  - `apps/admin-web/src/app/[locale]/(console)/contacts/exports/`
  - `apps/admin-web/messages/es/contacts-import.json`
  - `apps/admin-web/messages/pt/contacts-import.json`
  - `apps/admin-web/messages/en/contacts-import.json`

### F1.5.T5 — Datos relacionales y acciones GDPR en la consola

- `src/app/[locale]/(console)/contacts/relational/`: listado de tablas relacionales, alta con definición de columnas y tipos, agregar columnas, borrar tabla con confirmación.
- En la ficha del contacto (`contacts/[id]/`, creada en F1.5.T2): pestaña de datos relacionales por tabla, y acciones GDPR "Exportar datos del contacto" (muestra el enlace cuando el job termina) y "Olvidar contacto" con confirmación doble (escribir el email del contacto) visibles solo con `contacts:admin`.
- `src/app/[locale]/(console)/contacts/gdpr/`: historial de solicitudes GDPR con estado.
- Mensajes en `messages/<locale>/contacts-relational.json`.

Cubre FR-15, FR-16, NFR-15.

Done when: tests de componentes con MSW verifican crear la tabla "mascotas", ver sus filas en la ficha, y que "Olvidar contacto" no se habilita hasta escribir el email exacto; sin violaciones axe.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Pantallas estándar con una confirmación destructiva que conviene cuidar.
- **Dependencies**: F1.5.T2
- **Files**:
  - `apps/admin-web/src/app/[locale]/(console)/contacts/relational/`
  - `apps/admin-web/src/app/[locale]/(console)/contacts/gdpr/`
  - `apps/admin-web/src/app/[locale]/(console)/contacts/[id]/`
  - `apps/admin-web/messages/es/contacts-relational.json`
  - `apps/admin-web/messages/pt/contacts-relational.json`
  - `apps/admin-web/messages/en/contacts-relational.json`

## F1.6 — Package: wiring y e2e F1

### F1.6.T1 — Cierre de F1: base de contactos verificada

Gate de fase. Con la plataforma levantada desde un clon limpio (`make up && make seed`), correr `make e2e` completo (suites de F0 y la de F1.6.T3), la suite de seguridad de core y los tests de todos los servicios; corregir defectos de integración dentro de los archivos listados o reportarlos como bloqueo; y dejar `tests/e2e/contacts/CHECKLIST.md` con FR-7..FR-16, NFR-8 y NFR-10 marcados con el test que los prueba y su resultado, incluidas las mediciones del import de 1 M (duración y memoria) y del export. Verificar con axe (Playwright) las pantallas de contactos (NFR-15).

Done when: en un clon limpio `make up && make seed && make e2e` termina en 0, `CHECKLIST.md` no tiene ítems pendientes y CI está en verde.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Verificación e integración de piezas ya construidas.
- **Dependencies**: F1.6.T3, F1.5.T1, F1.5.T3, F1.5.T4, F1.5.T5
- **Files**:
  - `tests/e2e/contacts/CHECKLIST.md`

### F1.6.T2 — Wiring de módulos, compose y gateway

- Registrar en `services/core/src/app.module.ts` los módulos `fields`, `contacts-write`, `contacts-query`, `lists`, `consents`, `relational`, `gdpr` y el seeder de `contacts-shared`.
- Incluir `deploy/compose/services/importer.yml` en `deploy/compose/docker-compose.yml`.
- `deploy/traefik/dynamic/contacts.yml`: hacia core `/api/v3/{field,contact,contactlist,gdpr,relational}` y `/admin/v1/{fields,contacts,lists,relational-tables,gdpr-requests}`; hacia importer `/api/v3/{import,export,jobs}` y `/admin/v1/{imports,exports,jobs}`; middlewares `secure-headers` y `ratelimit-tenant`. Quitar de `deploy/traefik/dynamic/core.yml` cualquier regla que entre en conflicto con `/api/v3/jobs` (ahora de importer).
- Agregar las rutas nuevas de core a la matriz de `services/core/test/security/` (acceso cruzado y permisos).
- Seed `scripts/seed/10-contacts/seed.ts`: 3 campos custom (país de interés, talle, fecha de última compra), 1.000 contactos, 2 listas y la tabla relacional "mascotas" en el tenant demo, vía API pública.

Cubre NFR-8, NFR-13.

Done when: con la plataforma arriba, `curl` autenticado a `/api/v3/field` responde desde core y a `/api/v3/jobs/<id>` desde importer, `pnpm --filter @oe/core test:security` pasa con las rutas nuevas y `make seed` carga los datos de contactos dos veces sin duplicar.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Cableado y configuración sobre módulos ya construidos, más ampliar una suite existente.
- **Dependencies**: F1.2.T4, F1.2.T5, F1.2.T6, F1.3.T2, F1.4.T2, F1.4.T3
- **Files**:
  - `services/core/src/app.module.ts`
  - `deploy/compose/docker-compose.yml`
  - `deploy/traefik/dynamic/contacts.yml`
  - `deploy/traefik/dynamic/core.yml`
  - `services/core/test/security/`
  - `scripts/seed/10-contacts/`

### F1.6.T3 — Suite e2e de contactos

Suite `tests/e2e/contacts/` (Playwright para UI + requests para API) contra la plataforma con el seed, con un token de API client del seed:
1. Campo custom creado por API conserva su ID al renombrarlo por consola (FR-7).
2. `PUT /api/v3/contact` con 998 válidos + 2 inválidos: 998 persistidos y 2 errores por posición (FR-8).
3. `getdata` de 3 emails con campos 1 y 3 (FR-9).
4. Buscar por email en la consola y abrir la ficha (FR-10).
5. Import por consola de un CSV de 1 M de filas generado por `tests/e2e/contacts/fixtures/gen-csv.ts` con filas inválidas: el job termina sin intervención y el reporte lista cada fila rechazada (FR-11); anotar duración.
6. Export por API → `job_id` → descarga del CSV → el enlace expira (TTL corto configurado para e2e) (FR-12).
7. Agregar 500 contactos a una lista por API y ver conteo 500 (FR-13).
8. Cambios de consentimiento visibles en el historial de la ficha (FR-14).
9. GDPR export descargable y olvido: el contacto desaparece de búsqueda, `getdata`, listas y export (FR-15).
10. Tabla relacional "mascotas" con filas visibles en la ficha (FR-16; el filtro por segmento se prueba en F3).
11. Un API client del tenant A no lee ni escribe contactos del tenant B (NFR-8).

Done when: `make e2e` pasa los 11 escenarios contra la plataforma cableada en F1.6.T2.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Tests de punta a punta extensos sobre contratos ya fijados.
- **Dependencies**: F1.6.T2
- **Files**:
  - `tests/e2e/contacts/`
