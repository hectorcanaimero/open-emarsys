---
type: spec
project_id: open-emarsys
phase: 5
version: 0.1
depends_on:
  - docs/arch/001-open-emarsys.md
  - docs/prd/001-open-emarsys.md
consumed_by:
  - orch-atomizer
generated_by: orch-spec
generated_at: 2026-09-17
title: Automation Center
---

# F5 — Automation Center

Milestone M5 del PRD (FR-38 a FR-46, NFR-11). Nacen automation (NestJS: diseño y versionado de programas) y engine (Go: worker Temporal que los ejecuta). Contratos en `docs/arch/001-open-emarsys.md` §Interfaces C1, C4, C5, C6, C7 y C11, y decisiones D2 y D9. Regla transversal: **cada contacto ejecuta la versión del grafo con la que entró** (FR-43), y todo efecto externo es una activity idempotente (NFR-11).

## F5.1 — Package: contracts programas

### F5.1.T1 — JSON Schema del grafo de programas y fixtures

Escribir `contracts/dsl/program.schema.json` (draft 2020-12) exactamente como C7:

- **Tipos de trigger:** `segment_entry{segment_id}`, `external_event{external_event_id}`, `behavior{event, where[]}`, `field_change{field_id, to?}`, `date_field{field_id, offset_days, at_local_time}`, `schedule{cron, timezone, segment_id?}` y `manual`. `loyalty` queda reservado para F9 y el schema lo rechaza.
- **Reingreso:** `once`, `every{days}` y `always`.
- **Nodos:** `wait{duration ISO-8601}`, `wait_until{event, timeout}` con ramas `event|timeout`, `split_condition{definition: C6 root}` con ramas `yes|no`, `split_random{weights[]}` con ramas `b0..bn`, `split_model{score, threshold}` con ramas `above|below` (válido en el schema, habilitado en F6), `send{channel: email, content_version_id, sender_id, sto}`, `update_field`, `list{op, list_id}`, `webhook{url https, method, headers, body}`, `enroll{program_id}` y `exit`.
- **Aristas:** `edges[{from, to, branch?}]`.
- **Límites:** 200 nodos, `split_random` de 2 a 5 ramas con pesos que suman 100.

Referenciar `segment.schema.json` para `definition`. Fixtures en `contracts/dsl/fixtures/programs/valid/` (incluido `abandoned-cart.json`: behavior cart → wait PT2H → wait_until purchase P2D → send en timeout) e `invalid/` (peso que no suma 100, trigger desconocido, `webhook` con http, nodo sin id). Las reglas estructurales que no expresa JSON Schema (ciclos, huérfanos, ramas faltantes) se documentan en `contracts/dsl/program-rules.md` para que automation y engine las apliquen igual. Cubre FR-38 a FR-44.

Done when: el validador de contracts de CI acepta todos los fixtures `valid/` y rechaza todos los `invalid/`.

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Contrato central que comparten el editor, la validación y el intérprete durable; los errores aquí se arrastran a toda la fase.
- **Dependencies**: F4.7.T1
- **Files**:
  - `contracts/dsl/program.schema.json`
  - `contracts/dsl/program-rules.md`
  - `contracts/dsl/fixtures/programs/`

### F5.1.T2 — Eventos programs.*

JSON Schema sobre el envelope C1, cada uno con ejemplo:

- `programs.version.published`: `program_id, version_id, number, trigger_type`.
- `programs.status.changed`: `program_id, version_id, status: active|paused|stopped`.
- `programs.node.entered` y `programs.node.exited`: `program_id, version_id, node_id, branch?, workflow_id`.
- `programs.node.suppressed`: `program_id, version_id, node_id, reason: frequency_cap|consent`.
- `programs.enrollment.requested`: `program_id, contact_id, source: manual|enroll_node, parent_workflow_id?`. Lo usan la inscripción manual por API y el nodo `enroll`.

Cubre FR-39, FR-43, FR-44 y FR-45.

Done when: el validador de contracts pasa con los 6 esquemas y sus ejemplos.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 1h
- **Reason**: Esquemas simples sobre un envelope existente.
- **Dependencies**: F4.7.T1
- **Files**:
  - `contracts/events/programs.version.published.schema.json`
  - `contracts/events/programs.status.changed.schema.json`
  - `contracts/events/programs.node.entered.schema.json`
  - `contracts/events/programs.node.exited.schema.json`
  - `contracts/events/programs.node.suppressed.schema.json`
  - `contracts/events/programs.enrollment.requested.schema.json`
  - `contracts/events/examples/programs/`

### F5.1.T3 — OpenAPI de automation

Escribir `contracts/openapi/admin-v1/automation.yaml` (C3):

- programas (CRUD de borrador con `graph` del schema de F5.1.T1);
- `POST /programs/{id}/validate` → `{errors[{node_id, code, message}]}`;
- `POST /programs/{id}/publish` → versión;
- `POST /programs/{id}/status` (`active|paused|stopped`);
- `GET /programs/{id}/versions`;
- `GET /programs/{id}/stats?version_id` → por nodo `{entered, exited_by_branch, waiting, suppressed}`;
- `GET /programs/{id}/journey?contact_id` → pasos con timestamp.

Agregar a `contracts/openapi/public-v3.yaml` `GET /program` y `POST /program/{id}/trigger` (`key_id`, `external_ids[]`, envelope C2). Crear `contracts/openapi/internal/automation.yaml` con `GET /internal/v1/programs/active` → `[{program_id, version_id, graph}]` (carga inicial del índice de engine) y `GET /internal/v1/program-versions/{id}`. Cubre FR-38, FR-43 y FR-45.

Done when: redocly lint pasa sobre los tres archivos.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: API REST convencional a partir de contratos definidos.
- **Dependencies**: F5.1.T1
- **Files**:
  - `contracts/openapi/admin-v1/automation.yaml`
  - `contracts/openapi/public-v3.yaml`
  - `contracts/openapi/internal/automation.yaml`

### F5.1.T4 — Regenerar tipos TypeScript y Go del grafo

Correr el codegen de F0.3 para `packages/ts-contracts` (OpenAPI de automation, eventos `programs.*` y tipo `ProgramGraph` desde el JSON Schema) y generar structs Go del grafo en `libs/go/oe/contracts/program` con `go-jsonschema` agregado a `scripts/codegen/`. No escribir tipos a mano.

Done when: `pnpm --filter ts-contracts build` exporta `ProgramGraph` y `AutomationApi`, y `go build ./libs/go/oe/contracts/program/...` compila.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 1.5h
- **Reason**: Codegen mecánico.
- **Dependencies**: F5.1.T2, F5.1.T3
- **Files**:
  - `packages/ts-contracts/src/generated/`
  - `libs/go/oe/contracts/program/`
  - `scripts/codegen/program-go.sh`

## F5.2 — Package: automation service

### F5.2.T1 — Scaffold del servicio automation

Crear el servicio NestJS `services/automation` con el patrón de content (F4.2.T1): auth/permisos (`automation:view|edit|launch`), RLS, OTel, `/health`, Prisma multiarchivo (`prisma/schema/base.prisma`, schema `automation`), cliente ClickHouse de solo lectura, cliente gRPC `segments.v1`, `app.module.ts` sin módulos de dominio y `Dockerfile`. No editar `pnpm-workspace.yaml`.

Done when: `pnpm --filter automation build` y el test de `/health` pasan.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 2h
- **Reason**: Boilerplate que replica un patrón existente.
- **Dependencies**: F5.1.T4
- **Files**:
  - `services/automation/package.json`
  - `services/automation/tsconfig.json`
  - `services/automation/src/main.ts`
  - `services/automation/src/app.module.ts`
  - `services/automation/prisma/schema/base.prisma`
  - `services/automation/Dockerfile`
  - `services/automation/test/health.e2e-spec.ts`

### F5.2.T2 — Validación de programas

Módulo `validation`: `validate(graph, tenant) → errors[]`. Aplica en orden:

1. JSON Schema (ajv) de F5.1.T1.
2. Reglas estructurales de `contracts/dsl/program-rules.md`: sin ciclos, todo nodo alcanzable desde el trigger, cada split con todas sus ramas conectadas y ninguna arista duplicada.
3. Referencias existentes en el tenant: `content_version_id` (content interno), `sender_id` (campaigns interno), `list_id` y `field_id` (core interno), `segment_id` y `definition` (gRPC `segments.Count` con límite 1, que valida el DSL), `program_id` de `enroll`, sin autoinscripción.

Cada error lleva `node_id` y un código estable. Cubre FR-38 y FR-41.

Done when: tests unitarios recorren todos los fixtures `valid/` (sin errores) e `invalid/` (con el código esperado); hay tests de ciclo, nodo huérfano, rama faltante y referencia inexistente con clientes mockeados.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Algoritmos de grafos conocidos y llamadas a servicios; estándar.
- **Dependencies**: F5.2.T1
- **Files**:
  - `services/automation/src/modules/validation/`

### F5.2.T3 — Programas, versiones y estados

Módulo `programs`, tablas `programs` y `program_versions`:

- CRUD del borrador.
- `publish` valida con F5.2.T2 (422 con errores), crea una `program_version` inmutable con `number` incremental y publica `programs.version.published`.
- `status` gestiona las transiciones `draft → active ⇄ paused → stopped` (`stopped` es terminal) con permiso `automation:launch` y publica `programs.status.changed`.
- Publicar una versión nueva con el programa activo cambia `active_version_id` sin afectar ejecuciones en curso (FR-43).
- Endpoints internos `GET /internal/v1/programs/active` y `GET /internal/v1/program-versions/{id}` según `contracts/openapi/internal/automation.yaml`, solo para tokens `typ=service`.
- Audit log en cada escritura.

Cubre FR-38 y FR-43.

Done when: tests de integración cubren publicar v1 y v2 (v1 queda intacta), publicar un grafo inválido → 422, transición inválida → 409, eventos publicados que validan contra su schema, y lectura interna sin token de servicio → 401.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: CRUD con versionado inmutable y máquina de estados; estándar.
- **Dependencies**: F5.2.T2
- **Files**:
  - `services/automation/src/modules/programs/`
  - `services/automation/prisma/schema/programs.prisma`

### F5.2.T4 — Stats por nodo y recorrido de un contacto

Módulo `stats` sobre ClickHouse `program_events`:

- `GET /programs/{id}/stats` devuelve por nodo `entered`, `exited` por rama, `waiting` (entradas sin salida) y `suppressed`, filtrable por versión.
- `GET /programs/{id}/journey?contact_id` devuelve la secuencia ordenada de nodos con timestamp, rama y versión.

Consultas parametrizadas, siempre filtradas por `tenant_id`. Cubre FR-45.

Done when: test de integración con `program_events` sembrados verifica los contadores contra un conteo directo y el recorrido de un contacto en orden, y no devuelve datos de otro tenant.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2.5h
- **Reason**: Consultas analíticas acotadas.
- **Dependencies**: F5.2.T1
- **Files**:
  - `services/automation/src/modules/stats/`

### F5.2.T5 — API pública e inscripción manual

Módulo `public-api`: `GET /api/v3/program` (programas del tenant con estado) y `POST /api/v3/program/{id}/trigger` (envelope C2). La inscripción resuelve contactos por `key_id` con `POST /internal/v1/contacts/lookup` de core y publica un `programs.enrollment.requested` por contacto (`source=manual`). Rechaza programas no activos o sin trigger `manual`. Errores por ítem en `data.errors`. Cubre FR-39 (trigger manual).

Done when: tests de integración cubren inscribir 3 contactos (3 eventos publicados), un `external_id` inexistente en `data.errors`, y un programa pausado con `replyCode` de error.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Endpoint público fino sobre piezas existentes.
- **Dependencies**: F5.2.T3
- **Files**:
  - `services/automation/src/modules/public-api/`

### F5.2.T6 — Wiring de automation y tests de acceso cruzado

Registrar `validation`, `programs`, `stats` y `public-api` en `src/app.module.ts` (única tarea que lo edita), generar la migración Prisma con RLS del schema `automation` y agregar la suite de acceso cruzado de NFR-8 sobre todas las rutas admin, públicas e internas.

Done when: `pnpm --filter automation test` y `test:e2e` pasan, y la migración aplica en un Postgres limpio.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Integración y tests de seguridad multi-tenant.
- **Dependencies**: F5.2.T4, F5.2.T5
- **Files**:
  - `services/automation/src/app.module.ts`
  - `services/automation/prisma/migrations/`
  - `services/automation/test/cross-tenant.e2e-spec.ts`

## F5.3 — Package: engine interpreter

### F5.3.T1 — Scaffold del servicio engine

Crear el módulo Go `services/engine` (`go.mod` con `replace` a `libs/go/oe`) y agregarlo a `go.work` (única tarea de F5 que lo edita). `cmd/engine/main.go` mínimo: config, logger, OTel, cliente Temporal (namespace `open-emarsys`, cola `programs`) y worker vacío arrancado; `internal/config/` y `Dockerfile` distroless.

Done when: `go build ./services/engine/...` pasa y un test con `testsuite` de Temporal arranca el worker sin workflows.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 1.5h
- **Reason**: Scaffold mecánico.
- **Dependencies**: F5.1.T4
- **Files**:
  - `go.work`
  - `services/engine/go.mod`
  - `services/engine/cmd/engine/main.go`
  - `services/engine/internal/config/`
  - `services/engine/Dockerfile`

### F5.3.T2 — Modelo de grafo y navegación

Paquete `internal/graph` sobre los structs generados en `libs/go/oe/contracts/program`: `Compile(ProgramGraph) (*Graph, error)` indexa nodos y aristas, resuelve `Next(nodeID, branch) (nodeID, ok)` y `Start()`, y aplica las mismas reglas de `contracts/dsl/program-rules.md` (ciclos, huérfanos, ramas faltantes) como defensa en profundidad. Es determinista y sin I/O, así que se puede usar dentro de un workflow de Temporal.

Done when: `go test ./services/engine/internal/graph/...` recorre los fixtures `valid/` (compilan) e `invalid/` estructurales (fallan), más tests de `Next` por rama.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Estructura de datos pura con tests.
- **Dependencies**: F5.3.T1
- **Files**:
  - `services/engine/internal/graph/`

### F5.3.T3 — ProgramWorkflow: intérprete, esperas y versión fijada

Paquete `internal/workflow`: `ProgramWorkflow(ctx, input{tenant_id, program_id, version_id, contact_id, trigger_event})`.

- **Versión fijada:** carga el grafo con una activity `LoadVersion` (`GET /internal/v1/program-versions/{id}`), una sola vez al inicio, y lo guarda en el estado del workflow (FR-43).
- **Intérprete:** recorre nodos con `graph.Next`.
- **Esperas:**
  - `wait` usa `workflow.Sleep` con la duración ISO-8601.
  - `wait` con hora local del contacto calcula la duración desde su zona horaria, obtenida en la activity de contexto.
  - `wait_until` registra el interés con la activity `RegisterWaiter(event)`, espera con un `Selector` entre el signal channel `event:<type>` y un timer de `timeout`, desregistra con `UnregisterWaiter`, y sigue por la rama `event` o `timeout` (FR-40).
- **Registro de nodos:** cada nodo emite `programs.node.entered` y `programs.node.exited` con la activity `EmitNodeEvent`.
- **Salida:** `exit` o nodo sin salida terminan el workflow.
- **Continuidad:** `workflow.GetVersion` envuelve la lógica del intérprete; si el historial supera 1.000 eventos se usa `ContinueAsNew` conservando posición y grafo.

Las activities de nodo (`send`, `split_condition`, etc.) se invocan por nombre registrado. Esta tarea implementa solo `LoadVersion`, `RegisterWaiter`, `UnregisterWaiter` y `EmitNodeEvent` (registro Redis `waiting:<tenant>:<event>:<contact>` → set de workflow IDs). Cubre FR-40, FR-43 y NFR-11.

Done when: tests con `testsuite` (tiempo simulado) cubren: `wait` PT2H avanza a las 2 h; `wait_until` purchase P2D toma la rama `event` si llega el signal y `timeout` si no; un workflow que arrancó con v1 sigue en v1 aunque la activity devuelva v2 para nuevos; `ContinueAsNew` conserva la posición.

- **Model**: claude/claude-opus-5
- **Estimate**: 4h
- **Reason**: Motor durable con determinismo de Temporal, signals y versionado; un error pierde o duplica contactos.
- **Dependencies**: F5.3.T2
- **Files**:
  - `services/engine/internal/workflow/program.go`
  - `services/engine/internal/workflow/wait.go`
  - `services/engine/internal/workflow/program_test.go`
  - `services/engine/internal/activities/core.go`
  - `services/engine/internal/activities/waiters.go`

### F5.3.T4 — Splits de condición y aleatorio

En `internal/workflow/splits.go`:

- `split_condition` llama a la activity `IsMember`, que usa gRPC `segments.v1.Segments/IsMember` con `definition_json` (C5), y sigue por `yes` o `no`.
- `split_random` elige rama de forma determinista con `fnv64(contact_id + node_id) % 100` contra los pesos acumulados, sin `rand` dentro del workflow.
- `split_model` devuelve un error no reintentable `model_split_not_enabled` hasta F6 (lo reemplaza F6.6).

Implementar la activity `IsMember` en `internal/activities/segments.go` con timeout de 5 s y reintentos. Cubre FR-41.

Done when: tests con `testsuite` cubren ambas ramas de `split_condition` con la activity mockeada, y un test unitario de `split_random` 50/50 sobre 10.000 contact IDs deja cada rama entre 48% y 52%.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2.5h
- **Reason**: Lógica acotada dentro de un intérprete ya definido.
- **Dependencies**: F5.3.T3
- **Files**:
  - `services/engine/internal/workflow/splits.go`
  - `services/engine/internal/workflow/splits_test.go`
  - `services/engine/internal/activities/segments.go`

### F5.3.T5 — Tests de replay de workflows

Paquete `internal/replay`: grabar historiales JSON de ejecuciones reales en `testsuite` para los fixtures de `contracts/dsl/fixtures/programs/valid/` (incluido `abandoned-cart.json`) en `testdata/`, con un script `go run ./services/engine/internal/replay/record`, y un test que los reproduce con `worker.WorkflowReplayer`. Así, cualquier cambio no determinista del intérprete rompe CI (riesgo "versionado de workflows" del arch). Cubre NFR-11.

Done when: `go test ./services/engine/internal/replay/...` pasa, y cambiar el orden de dos activities en el intérprete hace fallar el test (verificado a mano y anotado en el README del paquete).

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Uso estándar del replayer de Temporal.
- **Dependencies**: F5.3.T4
- **Files**:
  - `services/engine/internal/replay/`

## F5.4 — Package: engine triggers y actions

### F5.4.T1 — Índice de programas activos

Paquete `internal/triggers/index.go`: índice en memoria `tenant → trigger type → []ActiveProgram{program_id, version_id, trigger}`. Carga inicial con `GET /internal/v1/programs/active` y actualización en vivo con el consumidor durable `engine-programs` sobre `oe.programs.version.published.*` y `oe.programs.status.changed.*` (paused y stopped salen del índice). Lecturas concurrentes seguras (`atomic.Pointer` a un snapshot inmutable). Cubre FR-39 y FR-43.

Done when: tests cubren carga inicial, publicar v2 que reemplaza a v1 en el índice, pausar que lo quita, y un test de carrera (`go test -race`) con lecturas y actualizaciones concurrentes.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Estructura concurrente simple.
- **Dependencies**: F5.3.T1
- **Files**:
  - `services/engine/internal/triggers/index.go`
  - `services/engine/internal/triggers/index_test.go`

### F5.4.T2 — Trigger router, reingreso y señales de espera

Paquete `internal/triggers`:

- **Router.** Consumidores durables JetStream: `engine-behavior` (`oe.behavior.tracked.*`), `engine-external` (`oe.external_event.triggered.*`), `engine-contacts` (`oe.contacts.upserted.*` para `field_change`, comparando `changed[]` y el valor nuevo), `engine-segments` (`oe.segments.run.completed.*` para `segment_entry`: nuevos miembros = diferencia con el run anterior en `segment_members`) y `engine-enroll` (`oe.programs.enrollment.requested.*`).
- **Arranque de workflows.** Por cada evento se buscan los programas que coinciden en el índice (incluido el filtro `where` de `behavior`) y se arranca `ProgramWorkflow` con `WorkflowID = prog:<programId>:<contactId>:<entryKey>` (C7). La `entryKey` sale de la regla de reingreso: `once` → `0`, `every{days}` → `floor(epoch_days/days)`, `always` → `event.id`. Se usa `WorkflowIDReusePolicy` = RejectDuplicate, de modo que un duplicado ya en curso o cerrado no reinscribe (FR-44).
- **Señales de espera.** Por cada evento de comportamiento o externo se leen los waiters `waiting:<tenant>:<event>:<contact>` y se envía `SignalWorkflow(event:<type>)` a cada workflow registrado (FR-40).
- **Garantías.** Ack después de arrancar o señalar; errores de Temporal → `Nak` con backoff (NFR-11).

Cubre FR-39, FR-40 y FR-44.

Done when: tests de integración (NATS y Redis en testcontainers + `testsuite` de Temporal o servidor dev) cubren: un evento cart inscribe en el programa de carrito; el mismo evento reentregado no crea un segundo workflow; con `every{days:7}` una segunda entrada al día 3 se rechaza y al día 8 se acepta; un evento purchase señala al workflow que espera.

- **Model**: claude/claude-opus-5
- **Estimate**: 4h
- **Reason**: Idempotencia de inscripción y enrutamiento de eventos a un motor durable; un error duplica o pierde contactos.
- **Dependencies**: F5.4.T1, F5.3.T3
- **Files**:
  - `services/engine/internal/triggers/router.go`
  - `services/engine/internal/triggers/reentry.go`
  - `services/engine/internal/triggers/signals.go`
  - `services/engine/internal/triggers/router_test.go`

### F5.4.T3 — Triggers de fecha y agenda recurrente

`internal/triggers/schedules.go`: al activar un programa con trigger `date_field` o `schedule`, se crea o actualiza una Temporal Schedule `sched:<programId>`, que se borra al pausar o detener. La schedule corre `ScheduledEnrollmentWorkflow`:

- `date_field` materializa vía gRPC `segments.Materialize` una definición con el criterio `field` + `cmp: "anniversary"` y `offset_days` (operador definido en F3.2.T5).
- `schedule` usa el `segment_id` opcional.

Luego pagina los miembros e inscribe a cada uno con el mismo `WorkflowID` de F5.4.T2, que da idempotencia si la schedule se reintenta. Cubre FR-39.

Done when: tests con `testsuite` cubren crear la schedule al activar y borrarla al pausar, y que la ejecución diaria de un programa de cumpleaños inscribe solo a los contactos con cumpleaños ese día (materialización mockeada).

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Uso estándar de Temporal Schedules sobre la inscripción idempotente ya definida.
- **Dependencies**: F5.4.T1
- **Files**:
  - `services/engine/internal/triggers/schedules.go`
  - `services/engine/internal/triggers/schedules_test.go`

### F5.4.T4 — Cap de frecuencia por contacto

Paquete `internal/frequency`: `Allow(ctx, tenant, contact, channel) (bool, error)` con contador Redis `freq:<tenant>:<contact>:<yyyymmdd>` en la zona horaria del contacto, INCR condicional atómico con script Lua y TTL de 48 h. El límite por canal sale de `tenants.limits.frequency` (ej. `{email: 1}`), leído con un endpoint interno nuevo de core `GET /internal/v1/tenants/{id}/limits` (token `typ=service`, caché de 60 s en engine). Sin límite configurado, todo está permitido. Cubre FR-44.

Done when: tests con Redis en testcontainers: con límite email = 1, el segundo `Allow` del día devuelve false y al día siguiente vuelve a true; un test del endpoint en core verifica 401 sin token de servicio.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2.5h
- **Reason**: Contador atómico y un endpoint interno simple.
- **Dependencies**: F5.3.T1
- **Files**:
  - `services/engine/internal/frequency/`
  - `services/core/src/modules/identity/internal/tenant-limits.controller.ts`
  - `services/core/src/modules/identity/internal/tenant-limits.controller.spec.ts`
  - `services/core/src/modules/identity/identity.module.ts`

### F5.4.T5 — Activities de acción

En `internal/activities/`:

- **`send.go`:** consulta `frequency.Allow`. Si se excede, emite `programs.node.suppressed` y el nodo sigue su única salida sin enviar. Si no, publica `messages.send.requested` con `message_id = uuidv5(workflowRunID + node_id)` (C7), `program_id`, `node_id` y `context.event` del trigger. Con `sto=true` deja `send_at` vacío y lo resuelve F6.
- **`fields.go`:** `update_field` renderiza el valor con placeholders `{{event.*}}` simples y llama a `POST /internal/v1/contacts/{id}/fields`.
- **`lists.go`:** llama a `POST /internal/v1/lists/{id}/members`.
- **`webhook.go`:** POST https con timeout de 10 s, reintentos para 5xx, sin reintento para 4xx, y cabecera `X-OE-Signature` con HMAC del cuerpo con el secreto del tenant.
- **`enroll.go`:** publica `programs.enrollment.requested` con `source=enroll_node`.

Registrar el despacho por tipo de nodo en el intérprete a través de un mapa de nombres de activity, sin editar `program.go`, en el archivo nuevo `internal/workflow/actions.go`. Cubre FR-42, FR-44 y NFR-11.

Done when: tests unitarios por activity con servidores HTTP de prueba y NATS en testcontainers; un test con `testsuite` verifica que el reintento de `send` publica el mismo `message_id` y que con el cap excedido no publica.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Varias activities simples con idempotencia ya resuelta por diseño.
- **Dependencies**: F5.3.T3, F5.4.T4
- **Files**:
  - `services/engine/internal/activities/send.go`
  - `services/engine/internal/activities/fields.go`
  - `services/engine/internal/activities/lists.go`
  - `services/engine/internal/activities/webhook.go`
  - `services/engine/internal/activities/enroll.go`
  - `services/engine/internal/activities/actions_test.go`
  - `services/engine/internal/workflow/actions.go`

### F5.4.T6 — Ensamblado de engine y test de integración

Completar `cmd/engine/main.go` e `internal/app`: registrar `ProgramWorkflow`, `ScheduledEnrollmentWorkflow` y todas las activities; arrancar índice, router y schedules; métricas OTel (`engine_enrollments_total`, `engine_signals_total`, `engine_suppressed_total`); apagado ordenado. Test de integración con el servidor dev de Temporal, NATS y Redis: activar el programa de carrito abandonado (fixture), publicar `behavior.tracked` cart, avanzar el tiempo (usando `PT2S` en el fixture de test) y verificar un `messages.send.requested`; repetir con una compra antes del timeout y verificar que no hay envío. Cubre FR-40, FR-42 y FR-46.

Done when: `go test -tags=integration ./services/engine/test/...` pasa.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Integración de piezas ya probadas.
- **Dependencies**: F5.4.T2, F5.4.T3, F5.4.T5, F5.3.T5
- **Files**:
  - `services/engine/cmd/engine/main.go`
  - `services/engine/internal/app/`
  - `services/engine/test/`

### F5.4.T7 — Consumidor sink de program_events

En `services/collector/internal/sink/programs.go`: consumidor durable JetStream `sink-programs` sobre `oe.programs.node.*` (entered, exited, suppressed; C1). Mapea a filas de ClickHouse `program_events` (`kind` = entered, exited o suppressed; `branch`, `version_id`, `node_id`, `contact_id` del envelope). Escribe por lotes (1.000 filas o 1 s) con ack después del INSERT. Se registra en el sink con `sink.Register` en `init()`, sin editar `cmd/sink/main.go`. Es la fuente de las stats y del recorrido (F5.2.T4). Cubre FR-45 y NFR-11.

Done when: test de integración (NATS y ClickHouse en testcontainers) en `programs_test.go` publica entered, exited con rama y suppressed, y verifica las filas; reentregar no duplica con `FINAL`.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Consumidor por lotes siguiendo el patrón existente del sink.
- **Dependencies**: F5.1.T2
- **Files**:
  - `services/collector/internal/sink/programs.go`
  - `services/collector/internal/sink/programs_test.go`

## F5.5 — Package: admin-web automation

### F5.5.T1 — Lienzo del editor de programas

Componente `program-editor` en `apps/admin-web/src/components/program-editor/`, con React Flow (`@xyflow/react`):

- paleta de nodos del schema C7, nodo trigger fijo y conexiones por rama (un handle por rama de cada split y de `wait_until`);
- serialización bidireccional `ProgramGraph ⇄ nodes/edges`, con posiciones guardadas en `graph.ui`;
- validación en vivo con ajv contra `program.schema.json`, más ciclos y huérfanos, marcando nodos con error;
- deshacer y rehacer;
- navegación por teclado entre nodos (NFR-15).

API `value/onChange/errors`. Textos con claves `automation.editor.*`. Cubre FR-38.

Done when: tests con Testing Library cubren que cargar el fixture `abandoned-cart.json` y serializarlo devuelve un grafo equivalente, que conectar un ciclo marca error, y que borrar un nodo borra sus aristas.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Componente UI complejo pero sin riesgo de seguridad.
- **Dependencies**: F5.1.T4
- **Files**:
  - `apps/admin-web/src/components/program-editor/canvas.tsx`
  - `apps/admin-web/src/components/program-editor/serialize.ts`
  - `apps/admin-web/src/components/program-editor/serialize.test.ts`
  - `apps/admin-web/src/components/program-editor/validate.ts`
  - `apps/admin-web/src/components/program-editor/index.ts`

### F5.5.T2 — Paneles de configuración por nodo

En `apps/admin-web/src/components/program-editor/panels/`, un panel por tipo de nodo y de trigger:

- selector de External Event, de evento de comportamiento con filtros, de campo y de segmento;
- editor de reingreso;
- duración ISO-8601 con UI amigable (número + unidad);
- `wait_until` con evento y timeout;
- `split_condition` reutilizando `components/segment-builder` de F3.4;
- pesos de `split_random` que deben sumar 100;
- `send` con selector de versión de contenido y remitente;
- `update_field`, `list` y `webhook` (solo https);
- `enroll` con selector de programa.

Cada panel emite el fragmento de nodo del schema. Cubre FR-39, FR-40, FR-41 y FR-42.

Done when: tests con Testing Library por panel verifican que el nodo emitido valida contra el schema, y que pesos 60/30 muestran error y bloquean aplicar.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Formularios UI múltiples; estándar.
- **Dependencies**: F5.1.T4
- **Files**:
  - `apps/admin-web/src/components/program-editor/panels/`

### F5.5.T3 — Pantallas de programas

Rutas `(console)/automation/`:

- listado con estado y versión activa;
- crear y editar con lienzo y paneles;
- botón validar con errores del servidor por nodo;
- publicar;
- activar, pausar y detener, con confirmación y solo con `automation:launch`;
- historial de versiones en solo lectura.

Cliente tipado de `@oe/ts-contracts`. Cubre FR-38 y FR-43.

Done when: test Playwright con MSW crea un programa de carrito abandonado desde cero, lo publica, lo activa y ve v1 en el historial; un usuario sin `automation:launch` no ve el botón activar.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Pantallas CRUD sobre componentes ya hechos.
- **Dependencies**: F5.5.T1, F5.5.T2
- **Files**:
  - `apps/admin-web/src/app/[locale]/(console)/automation/page.tsx`
  - `apps/admin-web/src/app/[locale]/(console)/automation/new/`
  - `apps/admin-web/src/app/[locale]/(console)/automation/[id]/page.tsx`
  - `apps/admin-web/src/app/[locale]/(console)/automation/[id]/versions/`

### F5.5.T4 — Overlay de stats y recorrido de un contacto

Overlay sobre el lienzo con contadores por nodo (entraron, esperando, salieron por rama, suprimidos) de `GET /programs/{id}/stats`, con refresco cada 30 s y filtro por versión. Ruta `(console)/automation/[id]/journey/` con buscador de contacto por email que muestra su recorrido (nodos resaltados en el lienzo en solo lectura más una lista con fecha, rama y versión). Cubre FR-45.

Done when: test Playwright con MSW muestra los contadores del mock sobre cada nodo y, al buscar un contacto, resalta los nodos de su recorrido.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: UI de lectura sobre componentes existentes.
- **Dependencies**: F5.5.T3
- **Files**:
  - `apps/admin-web/src/components/program-editor/stats-overlay.tsx`
  - `apps/admin-web/src/app/[locale]/(console)/automation/[id]/journey/`

### F5.5.T5 — Navegación y traducciones de automation

Crear `src/nav/automation.ts` (entrada Automation Center con permiso `automation:view`) y completar `messages/{es,pt,en}/automation.json` con todas las claves `automation.*` usadas por F5.5.T1–T4. Correr `scripts/codegen/nav.mjs`. Cubre FR-5.

Done when: el chequeo de claves faltantes de next-intl pasa en los tres idiomas.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 1h
- **Reason**: Traducciones y registro mecánico.
- **Dependencies**: F5.5.T4
- **Files**:
  - `apps/admin-web/src/nav/automation.ts`
  - `apps/admin-web/messages/es/automation.json`
  - `apps/admin-web/messages/pt/automation.json`
  - `apps/admin-web/messages/en/automation.json`

## F5.6 — Package: wiring y e2e F5

### F5.6.T1 — Gate F5: e2e de carrito abandonado y versionado

Cierre de fase. Con Compose completo, `tests/e2e/automation/abandoned-cart.spec.ts`:

1. En admin-web (Playwright) se crea el programa de carrito abandonado (behavior cart → wait → wait_until purchase con timeout → send email con los productos del carrito vía `event.item_ids`), se publica y se activa.
2. En demo-shop un contacto identificado agrega productos y no compra: tras la espera llega a Mailpit el email con esos productos (FR-46).
3. Un segundo contacto compra antes del timeout: no recibe email y su recorrido muestra la rama `event`.

`versioning.spec.ts`: con un contacto esperando en v1, se publica v2 con otro asunto; el contacto recibe el asunto de v1 y uno nuevo recibe el de v2 (FR-43). Las duraciones de los programas de test usan segundos. Cubre FR-38, FR-40, FR-43, FR-45 y FR-46.

Done when: `pnpm test:e2e --filter automation` pasa contra `docker compose up` limpio, incluyendo los escenarios de F5.6.T3.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: e2e largo sobre servicios probados.
- **Dependencies**: F5.2.T6, F5.4.T6, F5.4.T7, F5.5.T5, F5.6.T2, F5.6.T3
- **Files**:
  - `tests/e2e/automation/abandoned-cart.spec.ts`
  - `tests/e2e/automation/versioning.spec.ts`

### F5.6.T2 — Compose y gateway de automation y engine

Crear `deploy/compose/services/automation.yml` y `deploy/compose/services/engine.yml` (build, env, healthcheck, límites de memoria; engine depende de Temporal), incluirlos en `deploy/compose/docker-compose.yml`, y crear `deploy/traefik/dynamic/automation.yml` con `/admin/v1/automation` y `/api/v3/program` hacia automation (engine y `/internal/v1` no se exponen). Agregar rol y schema `automation` al init de Postgres, y el namespace Temporal `open-emarsys` y su search attribute `TenantId` al init de `deploy/temporal`.

Done when: `docker compose up -d` deja automation y engine healthy, y `tctl --ns open-emarsys namespace describe` (o `temporal operator namespace describe`) responde.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 1.5h
- **Reason**: Configuración declarativa.
- **Dependencies**: F5.2.T6, F5.4.T6
- **Files**:
  - `deploy/compose/services/automation.yml`
  - `deploy/compose/services/engine.yml`
  - `deploy/compose/docker-compose.yml`
  - `deploy/traefik/dynamic/automation.yml`
  - `deploy/postgres/init/50-automation-schema.sql`
  - `deploy/temporal/init/open-emarsys-namespace.sh`

### F5.6.T3 — e2e de matriz de triggers, splits, acciones y frecuencia

`tests/e2e/automation/matrix.spec.ts` contra Compose, con programas creados por API:

- un programa por tipo de trigger (`segment_entry`, `external_event`, `behavior`, `field_change`, `date_field` con fecha de hoy, `schedule` con cron cercano, `manual` por API pública), cada uno inscribiendo al contacto esperado (FR-39);
- un programa por acción (`send`, `update_field`, `list`, `webhook` a un receptor de test que valida la firma, `enroll`) con su efecto observable (FR-42);
- `split_random` 50/50 sobre 1.000 contactos con cada rama entre 45% y 55% (tolerancia e2e; la exacta está en F5.3.T4) (FR-41);
- `split_condition` por segmento;
- con límite email = 1/día, un contacto que califica para dos programas recibe un solo email y el otro queda como suprimido en stats (FR-44).

Done when: `pnpm test:e2e --filter automation -- matrix` pasa.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Muchos escenarios e2e, pero cada uno es simple.
- **Dependencies**: F5.6.T2
- **Files**:
  - `tests/e2e/automation/matrix.spec.ts`
  - `tests/e2e/automation/fixtures/`
