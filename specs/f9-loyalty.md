---
type: spec
project_id: open-emarsys
phase: 9
version: 0.1
depends_on:
  - docs/arch/001-open-emarsys.md
  - docs/prd/001-open-emarsys.md
consumed_by:
  - orch-atomizer
generated_by: orch-spec
generated_at: 2026-09-17
title: Loyalty
---

# F9 — Loyalty

Milestone M9 del PRD: programa de fidelización con niveles, puntos, recompensas y vouchers, integrado con segmentos, personalización, programas y wallet. Cubre FR-65 a FR-68. Arquitectura: `docs/arch/001-open-emarsys.md`, componente *loyalty*, schema `loyalty` de *Data model*, contratos C1, C2, C4, C6, C7, C8 y paquetes F9.1–F9.4 de *Work breakdown*.

## F9.1 — Package: contracts loyalty

### F9.1.T1 — OpenAPI admin, pública e interna de loyalty

Escribir `contracts/openapi/admin-v1/loyalty.yaml` (C3): CRUD de programa (uno por tenant: nombre, moneda, período de cálculo de niveles, expiración de puntos en meses), niveles (`name`, `threshold`, `rank`), reglas (`kind`: `purchase_amount` con puntos por unidad de moneda, `purchase_count`, `event` con nombre de evento de comportamiento o External Event y puntos fijos; límite por contacto por período), recompensas (costo en puntos o nivel requerido, stock, carga de códigos de voucher por CSV o generación), vista de miembro (balance, nivel, ledger paginado, vouchers) y ajuste manual de puntos con motivo. Permisos `loyalty:view`, `loyalty:edit`. Agregar a `contracts/openapi/public-v3.yaml` las rutas de C2 F9: `GET /api/v3/loyalty/contacts/{id}` y `POST /api/v3/loyalty/contacts/{id}/redeem` (`reward_id`, idempotency key obligatoria). Escribir `contracts/openapi/internal/loyalty.yaml` con `POST /internal/v1/context` de C4 (`{tenant_id, contact_ids[]}` → `{contact_id: {points, tier, next_tier, points_to_next_tier, tier_since, vouchers[]}}`). Cubre FR-65, FR-67 y FR-68 a nivel contrato.

Done when: el linter de OpenAPI del CI pasa sobre los tres archivos y `pnpm --filter ts-contracts codegen` genera tipos.

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Diseño de contratos con dinero/puntos e idempotencia de canje; premium.
- **Dependencies**: F8.5.T1
- **Files**:
  - `contracts/openapi/admin-v1/loyalty.yaml`
  - `contracts/openapi/public-v3.yaml`
  - `contracts/openapi/internal/loyalty.yaml`

### F9.1.T2 — Eventos loyalty.*

Esquemas JSON (envelope C1) de `loyalty.points.changed` (`delta`, `balance`, `reason`: `accrual|redeem|expire|adjust`, `ref`), `loyalty.tier.changed` (`from_tier_id`, `to_tier_id`, `direction`: `up|down`) y `loyalty.reward.redeemed` (`reward_id`, `voucher_code`, `points`), con un ejemplo por tipo en `contracts/events/examples/`. Stream `LOYALTY`, subject `oe.<type>.<tenant_id>`.

Done when: el validador de fixtures de contratos del CI (F0.3) pasa con los tres ejemplos.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 1h
- **Reason**: Esquemas siguiendo un envelope ya definido; mecánico.
- **Dependencies**: F8.5.T1
- **Files**:
  - `contracts/events/loyalty.points.changed.schema.json`
  - `contracts/events/loyalty.tier.changed.schema.json`
  - `contracts/events/loyalty.reward.redeemed.schema.json`
  - `contracts/events/examples/loyalty.points.changed.json`
  - `contracts/events/examples/loyalty.tier.changed.json`
  - `contracts/events/examples/loyalty.reward.redeemed.json`

### F9.1.T3 — Extensiones de DSL: segmentos, programas y personalización

Habilitar loyalty en los DSL compartidos: en `contracts/dsl/segment.schema.json` el kind `loyalty` de C6 (`attr`: `tier|points|points_to_next_tier|tier_since_days`, `cmp`, `value`); en `contracts/dsl/program.schema.json` el trigger `loyalty` de C7 (`on`: `tier_up|tier_down|points_changed|reward_redeemed`, `tier_id` opcional); y escribir `contracts/dsl/loyalty-context.md` con las variables del contexto `loyalty` de C8 (`loyalty.points`, `loyalty.tier`, `loyalty.next_tier`, `loyalty.points_to_next_tier`, `loyalty.vouchers`) y su comportamiento cuando el contacto no es miembro (vacío, sin error). Agregar fixtures válidos e inválidos para cada extensión, incluido un fixture de render con "Te faltan {{loyalty.points_to_next_tier}} puntos" (FR-68).

Done when: los tests de schema del CI aceptan los fixtures válidos y rechazan los inválidos.

- **Model**: claude/claude-opus-5
- **Estimate**: 2h
- **Reason**: Cambia contratos centrales que consumen compilador, motor y renderizador; premium.
- **Dependencies**: F8.5.T1
- **Files**:
  - `contracts/dsl/segment.schema.json`
  - `contracts/dsl/program.schema.json`
  - `contracts/dsl/loyalty-context.md`
  - `contracts/dsl/fixtures/segments/loyalty/`
  - `contracts/dsl/fixtures/programs/loyalty/`
  - `contracts/dsl/fixtures/render/loyalty/`

## F9.2 — Package: loyalty service

### F9.2.T1 — Scaffold del servicio loyalty

Crear `services/loyalty` como servicio NestJS con `packages/ts-common` (auth + permisos, tenant context + extensión Prisma RLS, OTel, envelope público y problem+json, cliente NATS), Prisma multiarchivo con `prisma/schema/base.prisma` (schema `loyalty`) y `prisma/migrations/migration_lock.toml`, `/healthz`, Dockerfile y tests base. Los módulos los agregan F9.2.T2–T7; su registro en `app.module.ts` lo hace el gate F9.4.T1.

Done when: `pnpm --filter loyalty test` y `build` pasan y `/healthz` responde 200.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 1.5h
- **Reason**: Boilerplate NestJS conocido.
- **Dependencies**: F9.1.T1
- **Files**:
  - `services/loyalty/package.json`
  - `services/loyalty/tsconfig.json`
  - `services/loyalty/Dockerfile`
  - `services/loyalty/src/main.ts`
  - `services/loyalty/src/app.module.ts`
  - `services/loyalty/prisma/schema/base.prisma`
  - `services/loyalty/prisma/migrations/migration_lock.toml`
  - `services/loyalty/test/`

### F9.2.T2 — Programa, niveles y reglas

Módulo `program`: tablas `programs`, `tiers`, `rules` (schema `loyalty`, RLS por `tenant_id`) y endpoints admin de F9.1.T1. Validaciones: umbrales estrictamente crecientes por `rank`, un solo programa activo por tenant, parámetros de regla validados por `kind`. Toda escritura va al audit log (FR-6 vía `ts-common/audit`). Cubre FR-65 (configuración).

Done when: los tests de integración cubren CRUD, rechazo de umbrales no crecientes y acceso cruzado entre tenants con 404 (NFR-8).

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: CRUD con validaciones de dominio; standard.
- **Dependencies**: F9.2.T1
- **Files**:
  - `services/loyalty/src/modules/program/`
  - `services/loyalty/prisma/schema/program.prisma`
  - `services/loyalty/prisma/migrations/20260917090200_program/`

### F9.2.T3 — Ledger, balances y expiración

Módulo `ledger`: tabla `ledger` append-only (nunca UPDATE/DELETE; restricción con trigger que lo impide) y `balances` actualizada en la misma transacción con `SELECT ... FOR UPDATE` del balance. API interna del módulo `credit(contact, points, reason, ref, expires_at)` y `debit(...)` que rechaza saldo negativo, idempotente por `(tenant_id, reason, ref)` con índice único. Job diario de expiración que emite débitos `expire` por los puntos vencidos (FIFO por `expires_at`). Publica `loyalty.points.changed` tras el commit (outbox en la misma transacción, publicado por un relay). Ajuste manual admin con motivo. Consume `contacts.deleted` y anonimiza el ledger (NFR-10). Cubre FR-65.

Done when: los tests cubren créditos concurrentes (100 en paralelo sin perder puntos), débito sin saldo rechazado, doble crédito con mismo `ref` ignorado y expiración de puntos vencidos.

- **Model**: claude/claude-opus-5
- **Estimate**: 4h
- **Reason**: Contabilidad de puntos con concurrencia, idempotencia y outbox; errores cuestan dinero; premium.
- **Dependencies**: F9.2.T2, F9.1.T2
- **Files**:
  - `services/loyalty/src/modules/ledger/`
  - `services/loyalty/prisma/schema/ledger.prisma`
  - `services/loyalty/prisma/migrations/20260917090300_ledger/`

### F9.2.T4 — Acumulación desde órdenes y eventos

Módulo `accrual`: consumidores JetStream durables `loyalty-orders` (`oe.orders.created.*`) y `loyalty-behavior` (`oe.behavior.tracked.*`, `oe.external_event.triggered.*`) que evalúan las reglas activas del programa del tenant y acreditan con `ref = order_id` o `event_id` (idempotente vía F9.2.T3). `purchase_amount` redondea hacia abajo; respeta límites por período. Ignora contactos no identificados. Cubre FR-65: una compra de $100 con 1 punto/$ suma 100.

Done when: el test de integración publica `orders.created` de $100 y verifica balance 100; republicar el mismo mensaje no cambia el balance.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Consumidores y evaluación de reglas sobre un ledger ya idempotente.
- **Dependencies**: F9.2.T3
- **Files**:
  - `services/loyalty/src/modules/accrual/`

### F9.2.T5 — Evaluación de niveles

Módulo `tiers`: al cambiar el balance (listener interno de F9.2.T3) y en un job diario por el período de cálculo, recalcula el nivel según los puntos acumulados en el período (no el saldo canjeable) y los umbrales. Sube inmediatamente; baja solo al cerrar el período. Actualiza `balances.tier_id` y `tier_since` y publica `loyalty.tier.changed` por outbox. Cubre FR-66.

Done when: los tests verifican subida al superar el umbral con su evento, que canjear puntos no baja el nivel y que la bajada ocurre solo en el cierre de período.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Reglas de negocio con fechas; standard.
- **Dependencies**: F9.2.T3
- **Files**:
  - `services/loyalty/src/modules/tiers/`

### F9.2.T6 — Recompensas y vouchers

Módulo `rewards`: tablas `rewards` y `vouchers` (código único por tenant, índice único), carga de códigos por CSV y generación de códigos aleatorios (crypto, 12 caracteres sin ambigüedades). Canje transaccional: bloquea un voucher libre (`FOR UPDATE SKIP LOCKED`), debita puntos vía F9.2.T3 con `ref = idempotency key`, asigna el voucher y publica `loyalty.reward.redeemed`. Recompensas por nivel se asignan sin costo al subir de nivel, consumiendo el evento `loyalty.tier.changed` del bus (contrato F9.1.T2, sin acoplarse al código de F9.2.T5). Sin stock → error tipado. Cubre FR-67.

Done when: los tests verifican que un canje descuenta puntos y entrega un código no usado, que 50 canjes concurrentes con 10 vouchers entregan 10 y fallan 40 sin débito, y que repetir la idempotency key devuelve el mismo voucher.

- **Model**: claude/claude-opus-5
- **Estimate**: 4h
- **Reason**: Canje concurrente con dinero y códigos únicos; premium.
- **Dependencies**: F9.2.T3
- **Files**:
  - `services/loyalty/src/modules/rewards/`
  - `services/loyalty/prisma/schema/rewards.prisma`
  - `services/loyalty/prisma/migrations/20260917090600_rewards/`

### F9.2.T7 — API pública, vista de miembro y contexto interno

Módulo `public`: `GET /api/v3/loyalty/contacts/{id}` y `POST /api/v3/loyalty/contacts/{id}/redeem` (C2, envelope, scopes `loyalty.read`/`loyalty.write`). Módulo `members`: vista admin de miembro (balance, nivel, ledger paginado por cursor, vouchers). Módulo `internal`: `POST /internal/v1/context` (C4) por lotes de hasta 500 contactos con token `typ=service`, en una sola consulta. Cubre FR-67 y FR-68.

Done when: los tests verifican la respuesta de la API pública, el rechazo de un token de usuario en la ruta interna y que el contexto de 500 contactos responde en < 100 ms con datos seed.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Endpoints sobre lógica ya implementada; standard.
- **Dependencies**: F9.2.T5, F9.2.T6
- **Files**:
  - `services/loyalty/src/modules/public/`
  - `services/loyalty/src/modules/members/`
  - `services/loyalty/src/modules/internal/`

## F9.3 — Package: integración loyalty

### F9.3.T1 — Contexto loyalty en el render del dispatcher

En dispatcher, `internal/render/loyalty.go`: cuando la `content_version` usa variables `loyalty.*` (lista `variables` de C4), pide el contexto a `POST /internal/v1/context` de loyalty en lotes junto con la carga de contactos, con caché de 60 s por contacto, y lo expone al render Liquid según `contracts/dsl/loyalty-context.md`. Si loyalty no responde, el mensaje se reintenta (no se envía con datos vacíos). Cubre FR-68.

Done when: `go test ./internal/render/...` pasa los fixtures de `contracts/dsl/fixtures/render/loyalty/` con un servidor de contexto falso, incluido el caso de no miembro.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2.5h
- **Reason**: Extensión acotada del render con cliente HTTP y caché.
- **Dependencies**: F9.1.T1, F9.1.T3
- **Files**:
  - `services/dispatcher/internal/render/loyalty.go`
  - `services/dispatcher/internal/render/loyalty_test.go`

### F9.3.T2 — Réplica de balances en ClickHouse

Migración `0900_loyalty_replica.sql` con `loyalty_replica(tenant_id, contact_id, points, tier_id, tier_name, points_to_next_tier, tier_since, version)` `ReplacingMergeTree(version)`, y consumidor en sink (`internal/sink/loyalty.go`) de `loyalty.points.changed` y `loyalty.tier.changed` que escribe por lotes. El registro del consumidor en `cmd/sink/main.go` lo hace el gate F9.4.T1.

Done when: el test del sink con NATS y ClickHouse de testcontainers publica eventos y la réplica refleja el último balance.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Consumidor análogo a los sinks existentes.
- **Dependencies**: F9.1.T2
- **Files**:
  - `deploy/clickhouse/migrations/0900_loyalty_replica.sql`
  - `services/collector/internal/sink/loyalty.go`
  - `services/collector/internal/sink/loyalty_test.go`

### F9.3.T3 — Kind loyalty en el compilador de segmentos

En segments, `internal/compiler/loyalty.go`: compila el kind `loyalty` de C6 a una subconsulta `IN` sobre `loyalty_replica FINAL`. Tests golden de SQL con los fixtures de `contracts/dsl/fixtures/segments/loyalty/` y test de exactitud sobre un dataset chico ("nivel gold Y compró en 30 días"). Cubre FR-68.

Done when: `go test ./internal/compiler/...` pasa golden y exactitud; un kind loyalty con `attr` inválido devuelve el error tipado del compilador.

- **Model**: claude/claude-opus-5
- **Estimate**: 2.5h
- **Reason**: Cambio en el compilador de segmentos, donde un error da audiencias equivocadas; premium.
- **Dependencies**: F9.3.T2, F9.1.T3
- **Files**:
  - `services/segments/internal/compiler/loyalty.go`
  - `services/segments/internal/compiler/loyalty_test.go`
  - `services/segments/internal/compiler/testdata/loyalty/`

### F9.3.T4 — Trigger loyalty en engine

En engine, `internal/triggers/loyalty.go`: el trigger-router consume `oe.loyalty.>` y arranca `ProgramWorkflow` para programas activos con trigger `loyalty` que coincide (`on`, `tier_id`), con `WorkflowID` según la regla de reingreso de C7. El payload del evento queda en `event.*` para el render. Cubre FR-66 (dispara el trigger "cambio de nivel").

Done when: el test con el entorno de test de Temporal publica `loyalty.tier.changed` y verifica que se inicia exactamente un workflow para el programa que coincide y ninguno para el que filtra otro nivel.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Nuevo tipo de trigger sobre un router existente.
- **Dependencies**: F9.1.T2, F9.1.T3
- **Files**:
  - `services/engine/internal/triggers/loyalty.go`
  - `services/engine/internal/triggers/loyalty_test.go`

### F9.3.T5 — Sincronización de pases de wallet

En content, `src/modules/wallet/loyalty-sync/`: consumidor de `loyalty.points.changed` y `loyalty.tier.changed` que actualiza los pases de tarjeta de loyalty ya emitidos (Apple: push de actualización al web service del pase; Google: PATCH del objeto), con debounce de 30 s por contacto. Usa los adaptadores fake cuando no hay credenciales (PRD Q2). Cubre FR-58 y FR-68. El registro del submódulo en `wallet.module.ts` lo hace el gate F9.4.T1.

Done when: el test publica un cambio de puntos y verifica una sola llamada de actualización al adaptador fake con el nuevo balance.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2.5h
- **Reason**: Consumidor con debounce sobre adaptadores existentes.
- **Dependencies**: F9.1.T2
- **Files**:
  - `services/content/src/modules/wallet/loyalty-sync/`

## F9.4 — Package: admin-web loyalty y e2e

### F9.4.T1 — Wiring y e2e de F9

Cierre de fase. Registrar `program`, `ledger`, `accrual`, `tiers`, `rewards`, `public`, `members` e `internal` en `services/loyalty/src/app.module.ts`; registrar el consumidor loyalty en `services/collector/cmd/sink/main.go`; importar `loyalty-sync` en `services/content/src/modules/wallet/wallet.module.ts`; crear `deploy/compose/services/loyalty.yml` e incluirlo en `docker-compose.yml`; rutas Traefik `/admin/v1/loyalty` y `/api/v3/loyalty`; stream `LOYALTY` en la config de NATS si no existe. E2E en `tests/e2e/loyalty/`: compra de $100 en demo-shop → 100 puntos (FR-65) → supera umbral y sube de nivel → el programa con trigger "cambio de nivel" envía un email a Mailpit con "Te faltan N puntos" (FR-66, FR-68) → canje por API entrega un voucher y descuenta puntos (FR-67) → un segmento "nivel gold" incluye al contacto (FR-68).

Done when: `docker compose up` levanta loyalty sano y `pnpm test:e2e --project loyalty` pasa el escenario completo.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Wiring multi-servicio y e2e largo; standard con contexto amplio.
- **Dependencies**: F9.2.T4, F9.2.T7, F9.3.T1, F9.3.T3, F9.3.T4, F9.3.T5, F9.4.T3, F9.4.T4
- **Files**:
  - `services/loyalty/src/app.module.ts`
  - `services/collector/cmd/sink/main.go`
  - `services/content/src/modules/wallet/wallet.module.ts`
  - `deploy/compose/services/loyalty.yml`
  - `deploy/compose/docker-compose.yml`
  - `deploy/traefik/dynamic/loyalty.yml`
  - `deploy/nats/`
  - `tests/e2e/loyalty/`

### F9.4.T2 — Shell de loyalty y configuración del programa

Entrada de navegación `src/nav/loyalty.ts`, mensajes `messages/{es,pt,en}/loyalty.json` con las claves de todas las pantallas de F9, cliente tipado desde `contracts/openapi/admin-v1/loyalty.yaml`, layout de la sección y página `loyalty/program` (nombre, moneda, período de niveles, expiración). Permisos `loyalty:view`/`loyalty:edit`. Cubre FR-65 en la consola.

Done when: `pnpm --filter admin-web build` pasa y el test Playwright crea el programa y lo ve guardado en los tres idiomas.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 2h
- **Reason**: Wiring de sección y un formulario simple.
- **Dependencies**: F9.1.T1
- **Files**:
  - `apps/admin-web/src/nav/loyalty.ts`
  - `apps/admin-web/messages/es/loyalty.json`
  - `apps/admin-web/messages/pt/loyalty.json`
  - `apps/admin-web/messages/en/loyalty.json`
  - `apps/admin-web/src/lib/api/loyalty.ts`
  - `apps/admin-web/src/app/[locale]/(console)/loyalty/layout.tsx`
  - `apps/admin-web/src/app/[locale]/(console)/loyalty/program/`

### F9.4.T3 — Niveles, reglas y recompensas en admin-web

Páginas `loyalty/tiers` (lista ordenable con umbrales, validación de crecientes), `loyalty/rules` (formulario por `kind`) y `loyalty/rewards` (costo o nivel, stock, carga CSV de vouchers y generación). Cubre FR-65, FR-66 y FR-67 en la consola.

Done when: el test Playwright crea dos niveles, una regla de 1 punto/$ y una recompensa con 10 vouchers generados.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Varios formularios con validación; standard.
- **Dependencies**: F9.4.T2
- **Files**:
  - `apps/admin-web/src/app/[locale]/(console)/loyalty/tiers/`
  - `apps/admin-web/src/app/[locale]/(console)/loyalty/rules/`
  - `apps/admin-web/src/app/[locale]/(console)/loyalty/rewards/`

### F9.4.T4 — Vista de miembro

Página `loyalty/members/[contactId]` y pestaña "Loyalty" enlazada desde la ficha del contacto: balance, nivel con progreso al siguiente, ledger paginado, vouchers y ajuste manual de puntos con motivo obligatorio (permiso `loyalty:edit`). Cubre FR-68 en la consola.

Done when: el test Playwright abre un miembro del seed, ajusta +50 puntos con motivo y ve la entrada en el ledger.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Vista de datos con una acción; standard.
- **Dependencies**: F9.4.T2
- **Files**:
  - `apps/admin-web/src/app/[locale]/(console)/loyalty/members/`
