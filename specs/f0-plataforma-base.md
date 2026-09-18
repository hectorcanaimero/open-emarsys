---
type: spec
project_id: open-emarsys
phase: 0
version: 0.1
depends_on:
  - docs/arch/001-open-emarsys.md
  - docs/prd/001-open-emarsys.md
consumed_by:
  - orch-atomizer
generated_by: orch-spec
generated_at: 2026-09-17
title: Plataforma base
---

# F0 — Plataforma base

Milestone M0 del PRD: monorepo, infraestructura local, contratos base, librerías compartidas Go y TS, identidad (tenants, usuarios, roles, login, MFA, OAuth client credentials, audit log), consola vacía navegable en es/pt/en, gateway y seed. Cubre FR-1..FR-6 y sienta NFR-1, NFR-2, NFR-8, NFR-9, NFR-12, NFR-13, NFR-14, NFR-15, NFR-16. Referencia obligatoria: `docs/arch/001-open-emarsys.md` (Components → Layout del monorepo, Data model, Interfaces C1–C4 y C11).

## F0.1 — Package: monorepo

### F0.1.T1 — Scaffold del monorepo y tooling por lenguaje

Crear la raíz del monorepo según *Components → Layout del monorepo* del arch (NFR-1):
- `package.json` raíz privado con `packageManager` pnpm, scripts `build`, `lint`, `test`, `typecheck` delegando en Turborepo.
- `pnpm-workspace.yaml` con `apps/*`, `packages/*`, `services/*` (solo los que tengan `package.json`) y `tests/e2e`.
- `turbo.json` con pipelines `build` (depende de `^build`), `lint`, `test`, `typecheck`.
- `go.work` (Go 1.24) sin módulos todavía (`use` vacío); cada scaffold de servicio Go lo edita después (C11).
- `pyproject.toml` raíz como workspace de `uv` con `members = ["services/ml", "services/genai"]` (los directorios pueden no existir aún: dejarlo comentado y documentado).
- `biome.json` (formato + lint TS/JS), `.golangci.yml` (govet, staticcheck, errcheck, revive), configuración de `ruff` en `pyproject.toml`, `.editorconfig`.
- `Makefile` con targets estables que tareas posteriores rellenan con archivos propios: `up` (`docker compose -f deploy/compose/docker-compose.yml up -d`), `down`, `seed` (`scripts/seed/run.sh`), `e2e` (`tests/e2e/run.sh`), `lint`, `test`, `contracts` (`node scripts/codegen/validate-contracts.mjs`), `codegen` (`node scripts/codegen/gen.mjs`), `bench`. Cada target falla con un mensaje claro si su script todavía no existe.
- `README.md` con propósito, requisitos (Docker, pnpm, Go, uv, Node 22), mapa del layout y tabla de targets de make.

Done when: `pnpm install` corre sin errores, `make lint` termina en 0 sobre el repo vacío y `go work edit -json` y `uv lock` no fallan.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 2h
- **Reason**: Boilerplate de configuración sin lógica; el layout ya está fijado en el arch.
- **Dependencies**:
- **Files**:
  - `package.json`
  - `pnpm-workspace.yaml`
  - `turbo.json`
  - `go.work`
  - `pyproject.toml`
  - `biome.json`
  - `.golangci.yml`
  - `.editorconfig`
  - `Makefile`
  - `README.md`

### F0.1.T2 — CI base en GitHub Actions

Workflow `.github/workflows/ci.yml` que en cada push y PR corre, con caché por lenguaje: `pnpm install --frozen-lockfile`, `pnpm turbo lint typecheck test`, `go work sync` + `go vet ./...` + `go test ./...` sobre cada módulo listado en `go.work`, `uv sync` + `ruff check` + `pytest` cuando existan proyectos Python, y un job `contracts` que corre `make contracts` solo si `scripts/codegen/validate-contracts.mjs` existe (F0.3.T3 lo vuelve obligatorio). Servicios de CI: Postgres 17, Redis 7 y NATS 2.11 con JetStream como `services:` del job de integración. No tocar `.github/workflows/orch-ci.yml`. Cubre NFR-14.

Done when: `actionlint .github/workflows/ci.yml` pasa y un push a una rama muestra los jobs `node`, `go`, `python` y `contracts` en verde (los vacíos terminan en "skipped" o éxito).

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: YAML de CI con matrices y condiciones; estándar pero con detalles que conviene no errar.
- **Dependencies**: F0.1.T1
- **Files**:
  - `.github/workflows/ci.yml`

## F0.2 — Package: infra compose

### F0.2.T1 — Compose raíz con Postgres, Redis, MinIO y Mailpit

Crear `deploy/compose/docker-compose.yml` como archivo raíz que usa `include:` (C11) y define la red `oe` y volúmenes nombrados. En esta tarea incluye solo `deploy/compose/infra/postgres.yml`, `redis.yml`, `minio.yml` y `mailpit.yml`:
- PostgreSQL 17 con `deploy/postgres/init/00-roles.sql` que crea un rol y un schema por servicio del arch (`identity`, `contacts`, `events_registry`, `catalog`, `devices`, `inbox` para el rol `core`; `importer`, `segments`, `content`, `campaigns`, `dispatcher`, `automation`, `ml`, `analytics`, `loyalty`, `connectors`, `temporal`), cada rol con acceso solo a sus schemas y sin `BYPASSRLS` (NFR-8).
- Redis 7 con `appendonly no` (datos efímeros según *Data model → Redis*).
- MinIO con un job `minio-init` (`mc`) que crea los buckets `assets`, `imports`, `exports`, `models`, `opendata`, `wallet`.
- Mailpit con UI en 8025 y SMTP en 1025.
- Perfiles de Compose `core`, `data`, `ai`, `obs` (Risks del arch) y límites de memoria por contenedor; `deploy/compose/.env.example` con todas las variables.

Cubre NFR-2 y NFR-13 (parcial).

Done when: `docker compose -f deploy/compose/docker-compose.yml --profile core up -d` deja los 4 servicios healthy, `psql` con el rol `core` no puede leer el schema `campaigns`, y `mc ls` lista los 6 buckets.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Configuración de infraestructura con permisos por rol que deben quedar correctos desde el inicio.
- **Dependencies**: F0.1.T1
- **Files**:
  - `deploy/compose/docker-compose.yml`
  - `deploy/compose/.env.example`
  - `deploy/compose/infra/postgres.yml`
  - `deploy/compose/infra/redis.yml`
  - `deploy/compose/infra/minio.yml`
  - `deploy/compose/infra/mailpit.yml`
  - `deploy/postgres/init/00-roles.sql`

### F0.2.T2 — NATS JetStream, ClickHouse y Temporal

Agregar al compose raíz los includes `deploy/compose/infra/nats.yml`, `clickhouse.yml` y `temporal.yml`:
- NATS 2.11 con JetStream (`deploy/nats/nats.conf`) y un job `nats-init` que crea los streams de C1 (`CONTACTS`, `BEHAVIOR`, `MESSAGES`, `SEGMENTS`, `PROGRAMS`, `CATALOG`, `ML`, `LOYALTY`, `SYSTEM`) con sus subjects `oe.<type>.<tenant>` desde `deploy/nats/streams/*.json`, retención por límites, storage file, réplica 1 y `duplicate_window` de 2 min.
- ClickHouse 25.x con usuario por servicio lector/escritor, base `oe` y un runner de migraciones idempotente `deploy/clickhouse/migrate.sh` que aplica `deploy/clickhouse/migrations/*.sql` en orden y registra las aplicadas en `oe.schema_migrations`. Migración `0001_init.sql` que crea solo `oe.schema_migrations`.
- Temporal (auto-setup) persistiendo en el schema `temporal` de Postgres, namespace `open-emarsys` creado por un job init, y Temporal UI.

Cubre NFR-2.

Done when: `nats stream ls` muestra los 9 streams, `deploy/clickhouse/migrate.sh` corre dos veces sin error y `temporal operator namespace describe open-emarsys` responde.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Tres sistemas de infraestructura con bootstrap propio; sin lógica de negocio.
- **Dependencies**: F0.2.T1
- **Files**:
  - `deploy/compose/docker-compose.yml`
  - `deploy/compose/infra/nats.yml`
  - `deploy/compose/infra/clickhouse.yml`
  - `deploy/compose/infra/temporal.yml`
  - `deploy/nats/nats.conf`
  - `deploy/nats/streams/`
  - `deploy/clickhouse/migrate.sh`
  - `deploy/clickhouse/config/`
  - `deploy/clickhouse/migrations/0001_init.sql`
  - `deploy/temporal/`

### F0.2.T3 — Traefik y stack de observabilidad

Agregar al compose raíz `deploy/compose/infra/traefik.yml` y `deploy/compose/infra/observability.yml`:
- Traefik v3 como gateway (D11) con provider de archivos sobre `deploy/traefik/dynamic/` (cada servicio agrega su archivo en su tarea de wiring, C11), entrypoint `web` en 8080, dashboard protegido y access log JSON. `deploy/traefik/traefik.yml` estático; `deploy/traefik/dynamic/_middlewares.yml` con middlewares reutilizables (`ratelimit-ip`, `ratelimit-tenant` por cabecera `X-Tenant`, `secure-headers`).
- OpenTelemetry Collector (`deploy/observability/otel-collector.yaml`) que recibe OTLP gRPC/HTTP y exporta métricas a Prometheus, trazas a Tempo y logs a Loki; Grafana con datasources provisionados y un dashboard "Servicios" (latencia p50/p99, throughput y errores por `service.name`) en `deploy/observability/grafana/`.

Cubre NFR-12.

Done when: `curl localhost:8080/ping` responde OK vía Traefik, Grafana abre con los tres datasources en verde y un span enviado con `otel-cli` aparece en Tempo.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Configuración de observabilidad y gateway con varias piezas que deben encajar; estándar.
- **Dependencies**: F0.2.T2
- **Files**:
  - `deploy/compose/docker-compose.yml`
  - `deploy/compose/infra/traefik.yml`
  - `deploy/compose/infra/observability.yml`
  - `deploy/traefik/traefik.yml`
  - `deploy/traefik/dynamic/_middlewares.yml`
  - `deploy/observability/`

## F0.3 — Package: contracts base

### F0.3.T1 — Envelope de eventos y validación de contratos

Escribir `contracts/events/envelope.schema.json` (JSON Schema 2020-12) exactamente como C1: `id` UUID v7, `type` con patrón `^[a-z_]+(\.[a-z_]+)+$`, `schema_version` entero ≥1, `tenant_id` UUID, `occurred_at` RFC 3339 con milisegundos, `source`, `contact_id` UUID o null, `trace_parent` W3C opcional, `data` objeto. Cada evento futuro se define como `contracts/events/<type>.schema.json` con `allOf: [envelope, {properties: {type: {const}, data: {...}}}]`; documentar esa convención en `contracts/events/README.md` junto con la regla de subject `oe.<type>.<tenant_id>` y la tabla de streams de C1. Crear `contracts/events/examples/envelope.json` y el script `scripts/codegen/validate-contracts.mjs` (Ajv 2020 + `@apidevtools/swagger-parser`) que valida: cada `*.schema.json` compila, cada ejemplo en `contracts/events/examples/<type>.json` valida contra su schema, y cada `contracts/openapi/**/*.yaml` es OpenAPI 3.1 válido. Cubre NFR-2 y NFR-14.

Done when: `node scripts/codegen/validate-contracts.mjs` termina en 0, y alterar el `id` del ejemplo a un string no-UUID lo hace fallar con un mensaje que nombra el archivo.

- **Model**: claude/claude-opus-5
- **Estimate**: 2h
- **Reason**: Contrato base del bus del que dependen todos los servicios; un error aquí se propaga a todo el sistema.
- **Dependencies**: F0.1.T1
- **Files**:
  - `contracts/events/envelope.schema.json`
  - `contracts/events/README.md`
  - `contracts/events/examples/envelope.json`
  - `scripts/codegen/validate-contracts.mjs`

### F0.3.T2 — OpenAPI base pública y de identidad

Escribir dos documentos OpenAPI 3.1:
1. `contracts/openapi/public-v3.yaml` (C2): servers `/api/v3`, security scheme OAuth 2.0 client credentials con `tokenUrl: /api/v3/oauth/token`, componentes reutilizables `Envelope` (`replyCode`, `replyText`, `data`), `BatchErrors` (`data.errors[{index, key, code, text}]`), `JobAccepted` (`{job_id}`), `Job` (`id, kind, status, progress, result_url, error_report_url`), respuestas de error estándar 400/401/403/404/429 con envelope. Paths de esta fase: `POST /oauth/token` y `GET /jobs/{id}`. Dejar una sección de tags por fase para que F1+ agreguen paths.
2. `contracts/openapi/admin-v1/identity.yaml` (C3): JSON plano, errores `application/problem+json` (RFC 9457), paginación `?cursor&limit` → `{items, next_cursor}`, bearer JWT. Paths: `POST /auth/login` (email, password → `{mfa_required, mfa_token}` o tokens), `POST /auth/mfa/verify`, `POST /auth/refresh`, `POST /auth/logout`, `POST /me/mfa/enroll`, `POST /me/mfa/confirm`, `DELETE /me/mfa`, `PATCH /me` (locale); `GET/POST /tenants`, `GET/PATCH /tenants/{id}` (operador); `GET /users`, `POST /users/invitations`, `POST /invitations/{token}/accept`, `PATCH/DELETE /users/{id}`; `GET/POST /roles`, `PATCH/DELETE /roles/{id}` con `permissions[{module, action}]` y `action ∈ {view, edit, launch, admin}`; `GET/POST /api-clients`, `POST /api-clients/{id}/revoke` (el secret se devuelve una sola vez); `GET /audit-log` con filtros `actor_id, resource_type, from, to`. Documentar los claims del JWT en `components.schemas.JwtClaims`: `sub`, `typ ∈ {user, client, service}`, `tenant_id` (null para operador), `perms` (lista `module:action`) o `scopes`, `iat`, `exp`, `kid` en header.

Cubre FR-1, FR-2, FR-3, FR-4, FR-6 (contratos) y NFR-9.

Done when: `node scripts/codegen/validate-contracts.mjs` valida ambos archivos sin errores (si F0.3.T1 aún no está, `npx @redocly/cli lint` sobre ambos pasa).

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Diseño de contratos de autenticación y permisos que consumen core, admin-web y todas las librerías; sensible a seguridad.
- **Dependencies**: F0.1.T1
- **Files**:
  - `contracts/openapi/public-v3.yaml`
  - `contracts/openapi/admin-v1/identity.yaml`

### F0.3.T3 — Buf, codegen TS/Go y contratos en CI

- `proto/buf.yaml` (módulo único, lint `STANDARD`, breaking `FILE`) y `proto/buf.gen.yaml` con plugins `go`, `go-grpc` (salida en `libs/go/oe/gen/`) y `connect-es`/`es` (salida en `packages/ts-contracts/src/gen/proto/`). Aún no hay `.proto`: `buf lint` debe pasar vacío.
- `packages/ts-contracts`: `package.json` con exports por archivo, script `generate` que corre `openapi-typescript` sobre `contracts/openapi/**/*.yaml` hacia `src/gen/openapi/<nombre>.ts` y `json-schema-to-typescript` sobre `contracts/events/*.schema.json` hacia `src/gen/events/`. Los archivos generados van en `.gitignore` y se regeneran en `build` (así las tareas paralelas nunca se pisan).
- `scripts/codegen/gen.mjs` que orquesta TS + `buf generate`.
- Editar `.github/workflows/ci.yml` para que el job `contracts` sea obligatorio: `make contracts`, `buf lint`, `buf breaking --against` la rama base, y `make codegen` sin diffs.

Cubre NFR-14.

Done when: `make codegen` genera `packages/ts-contracts/src/gen/openapi/identity.ts` y `public-v3.ts`, `pnpm --filter @oe/ts-contracts build` compila, y el job `contracts` corre en CI.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Cableado de herramientas de codegen conocidas; estándar.
- **Dependencies**: F0.3.T1, F0.3.T2, F0.1.T2
- **Files**:
  - `proto/buf.yaml`
  - `proto/buf.gen.yaml`
  - `packages/ts-contracts/`
  - `scripts/codegen/gen.mjs`
  - `.github/workflows/ci.yml`

## F0.4 — Package: libs/go/oe

### F0.4.T1 — Módulo libs/go/oe: config, logging, OTel y HTTP

Crear el módulo Go `github.com/open-emarsys/oe/libs/go/oe` y agregarlo a `go.work`. Esta tarea es la única de F0.4 que edita `go.mod`/`go.sum`: declarar ya todas las dependencias del paquete (`nats.go`, `lestrrat-go/jwx/v2`, `jackc/pgx/v5`, `ClickHouse/clickhouse-go/v2`, `go.opentelemetry.io/otel` + exporters OTLP, `google/uuid`) y fijarlas con un `deps.go` de imports en blanco para que `go mod tidy` no las quite. Paquetes:
- `config`: carga desde env con prefijo por servicio y valores por defecto, error si falta un requerido.
- `log`: `slog` JSON con `service`, `tenant_id` y `trace_id` desde el contexto.
- `otel`: `Setup(ctx, serviceName)` que configura trazas, métricas y logs OTLP hacia el collector de F0.2.T3 y devuelve `shutdown`.
- `httpx`: servidor `net/http` con middlewares de recover, request id, OTel y access log; helpers `WriteEnvelope(w, replyCode, replyText, data)` (C2) y `WriteProblem(w, status, title, detail)` (C3, RFC 9457); health `/healthz` y `/readyz`.
- `tenant`: `WithTenant(ctx, uuid)` / `TenantFrom(ctx)`.

Cubre NFR-1, NFR-12.

Done when: `go test ./...` en `libs/go/oe` pasa con tests de `WriteEnvelope`, `WriteProblem` y del middleware de recover, y un binario de ejemplo en `libs/go/oe/examples/hello` emite un span visible en Tempo.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Librería base con piezas estándar de Go; sin lógica de seguridad.
- **Dependencies**: F0.3.T1, F0.3.T2
- **Files**:
  - `go.work`
  - `libs/go/oe/go.mod`
  - `libs/go/oe/go.sum`
  - `libs/go/oe/deps.go`
  - `libs/go/oe/config/`
  - `libs/go/oe/log/`
  - `libs/go/oe/otel/`
  - `libs/go/oe/httpx/`
  - `libs/go/oe/tenant/`
  - `libs/go/oe/examples/`

### F0.4.T2 — natsx: publicar y consumir con envelope

Paquete `libs/go/oe/natsx` sobre JetStream: `Publish(ctx, type string, tenantID uuid.UUID, contactID *uuid.UUID, data any)` arma el envelope de C1 (UUID v7, `occurred_at` en ms, `source` = nombre del servicio, `trace_parent` desde el span actual), publica en `oe.<type>.<tenant_id>` con cabecera `Nats-Msg-Id = id` y espera el ack. `Consume(ctx, stream, durable, filterSubject, handler func(ctx, Envelope) error, opts)` crea o reutiliza un consumidor durable pull con nombre `<servicio>-<propósito>`, propaga la traza y el tenant al contexto, hace `Ack` si el handler devuelve nil, `NakWithDelay` con backoff exponencial si devuelve error, y `Term` tras `MaxDeliver` enviando el mensaje a `oe.system.dead_letter.<tenant>`. Soporta lotes (`ConsumeBatch`) para los sinks. No editar `go.mod`. Cubre NFR-2, NFR-11.

Done when: tests de integración con `nats-server` embebido (`github.com/nats-io/nats-server/v2/test`) verifican publicación con dedupe por `Nats-Msg-Id`, reintento con nak, dead letter tras `MaxDeliver` y propagación de `trace_parent`.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Cliente de mensajería con semántica de reintentos bien documentada; estándar.
- **Dependencies**: F0.4.T1
- **Files**:
  - `libs/go/oe/natsx/`

### F0.4.T3 — auth: verificación de JWT, permisos y tokens de servicio

Paquete `libs/go/oe/auth`:
- `Verifier` que descarga el JWKS de core (`/.well-known/jwks.json`), lo cachea con refresco cada 10 min y ante un `kid` desconocido (con límite de 1 refresco por minuto), y valida RS256, `exp`, `iat` con 60 s de tolerancia y los claims de `JwtClaims` definidos en `contracts/openapi/admin-v1/identity.yaml`.
- Middleware HTTP `Require(perms ...string)` que acepta `typ=user` con `perms` que contengan `module:action`, `typ=client` con `scopes` equivalentes y `typ=service` para rutas `/internal/*`; responde 401 sin token válido y 403 sin permiso, y pone `tenant_id` y el principal en el contexto (paquete `tenant`).
- Interceptor gRPC equivalente para C5 (metadata `authorization`).
- `ServiceTokenSource` que obtiene y renueva un token `typ=service` de core con `client_id`/`client_secret` del servicio, para llamadas internas (C4).

No editar `go.mod`. Cubre NFR-8, NFR-9, FR-2 (enforcement).

Done when: tests con un JWKS de prueba cubren token válido, expirado, firma inválida, `kid` rotado, falta de permiso (403), `typ=user` intentando `/internal/*` (403) y ausencia de `tenant_id` para un usuario de tenant (401).

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Código de seguridad crítico que protegerá todos los servicios Go; exige máximo cuidado con casos borde.
- **Dependencies**: F0.4.T1
- **Files**:
  - `libs/go/oe/auth/`

### F0.4.T4 — pg con tenant y cliente ClickHouse

- `libs/go/oe/pg`: pool `pgxpool` con OTel; `InTenantTx(ctx, pool, fn func(pgx.Tx) error)` que abre una transacción y ejecuta `SET LOCAL app.tenant_id = $1` con el tenant del contexto antes de `fn` (falla si no hay tenant en el contexto), y `InSystemTx` explícito para jobs de plataforma; runner de migraciones SQL embebidas (`embed.FS`) con tabla de versiones por schema.
- `libs/go/oe/chx`: conexión `clickhouse-go/v2` nativa con OTel, `BatchInsert(ctx, table, rows)` con tamaño y flush por tiempo configurables, y helper `Query` que siempre exige un parámetro `tenant_id` (rechaza SQL sin el placeholder `{tenant_id:UUID}`).

No editar `go.mod`. Cubre NFR-8.

Done when: tests con testcontainers (Postgres 17 + ClickHouse) muestran que una tabla con política RLS `tenant_id = current_setting('app.tenant_id')::uuid` solo devuelve filas del tenant del contexto dentro de `InTenantTx`, que `InTenantTx` sin tenant devuelve error, y que `BatchInsert` escribe 10.000 filas en un flush.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Integración de drivers con una regla de aislamiento clara y testeable; estándar con tests fuertes.
- **Dependencies**: F0.4.T1
- **Files**:
  - `libs/go/oe/pg/`
  - `libs/go/oe/chx/`

### F0.4.T5 — keyring: clave maestra, derivación y cifrado

`libs/go/oe/keyring`: carga el anillo de claves maestras desde `OE_MASTER_KEYS` (`kid:base64,kid:base64`, 32 bytes cada una) y la activa desde `OE_MASTER_KEY_ID`; falla al arrancar si falta o si una clave no mide 32 bytes. API:
- `Derive(purpose string, tenantID uuid.UUID) []byte`: HKDF-SHA256 con info `oe/<purpose>/<tenant>`. La usan los tokens de tracking (C9) con purpose `track`.
- `Seal(purpose, plaintext) (string, error)`: AES-256-GCM con una subclave derivada, en formato `v1.<kid>.<nonce>.<ciphertext>` base64url.
- `Open(purpose, sealed)`: descifra con el `kid` que trae el sobre.

La rotación consiste en agregar una clave nueva, cambiar `OE_MASTER_KEY_ID` y re-sellar con un job; `Open` sigue leyendo sobres de claves viejas mientras estén en el anillo. Documentar el procedimiento y la generación (`openssl rand -base64 32`) en `docs/ops/keys.md`, e incluir la variable con una clave de desarrollo en `deploy/compose/.env.example`. Mismo formato que F0.5.T5, para que Go y Node lean los sobres del otro. Cubre NFR-9.

Done when: `go test ./libs/go/oe/keyring/...` pasa con: ida y vuelta Seal/Open; `Open` de un sobre de una clave rotada; error con `kid` desconocido; derivaciones distintas por tenant y purpose; y un vector de prueba fijo en `libs/go/oe/keyring/testdata/vectors.json` que F0.5.T5 también verifica.

- **Model**: claude/claude-opus-5
- **Estimate**: 2h
- **Reason**: Criptografía y rotación de claves; un error acá compromete tokens y secretos de todos los tenants.
- **Dependencies**: F0.4.T1
- **Files**:
  - `libs/go/oe/keyring/`
  - `docs/ops/keys.md`

## F0.5 — Package: packages/ts-common

### F0.5.T1 — Scaffold de ts-common: config, OTel y HTTP

Crear `packages/ts-common` (`@oe/ts-common`, ESM + CJS, TypeScript estricto). Esta es la única tarea de F0.5 que edita `package.json`: declarar ya todas las dependencias del paquete (`@nestjs/common`, `@nestjs/core`, `jose`, `nats`, `@prisma/client`, `kysely`, `@opentelemetry/sdk-node` + auto-instrumentations, `pino`, `zod`) y los subpath exports `./config`, `./otel`, `./http`, `./auth`, `./tenant`, `./prisma-tenant`, `./nats`, `./audit`, cada uno con su `src/<subpath>/index.ts`. Implementar en esta tarea:
- `config`: `loadConfig(schema: zod)` desde env con error legible.
- `otel`: `startOtel(serviceName)` para llamar antes del bootstrap de Nest.
- `http`: `ProblemJsonFilter` (C3, RFC 9457 para `/admin/v1` e `/internal/v1`), `PublicEnvelopeInterceptor` y `PublicEnvelopeFilter` (C2: `{replyCode, replyText, data}`, códigos de negocio en errores) aplicables por controlador, `CursorPage` helpers (`?cursor&limit` → `{items, next_cursor}`), logger pino JSON con `trace_id` y `tenant_id`.

Cubre NFR-1, NFR-12.

Done when: `pnpm --filter @oe/ts-common test` pasa con tests de ambos formatos de error y del envelope sobre una app Nest de prueba, y `pnpm --filter @oe/ts-common build` produce los 8 subpaths.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Paquete de utilidades NestJS con formatos ya definidos en los contratos; estándar.
- **Dependencies**: F0.3.T1, F0.3.T2
- **Files**:
  - `packages/ts-common/package.json`
  - `packages/ts-common/tsconfig.json`
  - `packages/ts-common/src/config/`
  - `packages/ts-common/src/otel/`
  - `packages/ts-common/src/http/`
  - `packages/ts-common/src/auth/index.ts`
  - `packages/ts-common/src/tenant/index.ts`
  - `packages/ts-common/src/prisma-tenant/index.ts`
  - `packages/ts-common/src/nats/index.ts`
  - `packages/ts-common/src/audit/index.ts`

### F0.5.T2 — Módulo de auth para NestJS

En `packages/ts-common/src/auth/`: `AuthModule.forRoot({jwksUrl, issuer})` con verificación RS256 vía `jose.createRemoteJWKSet` (cache y rotación por `kid`), `JwtAuthGuard` global que valida los claims `JwtClaims` de `contracts/openapi/admin-v1/identity.yaml`, decoradores `@Public()`, `@RequirePermission('module:action')` (acepta `perms` de usuario o `scopes` de client), `@InternalOnly()` (solo `typ=service`) y `@CurrentPrincipal()`. Respuesta 401 sin token válido, 403 sin permiso. `ServiceTokenClient` que obtiene y renueva tokens `typ=service` para llamadas C4. Para core, exponer también un `LocalKeyVerifier` que verifica con las llaves en memoria sin HTTP. No editar `package.json`. Cubre NFR-8, NFR-9, FR-2 (enforcement), FR-4 (scopes).

Done when: tests con un JWKS de prueba cubren token válido, expirado, `kid` rotado, `@RequirePermission` sin permiso (403), client con scope correcto (200), usuario contra `@InternalOnly` (403) y ruta `@Public` sin token (200).

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Guard de seguridad reutilizado por todos los servicios NestJS; errores aquí son vulnerabilidades.
- **Dependencies**: F0.5.T1
- **Files**:
  - `packages/ts-common/src/auth/`

### F0.5.T3 — Contexto de tenant y extensión Prisma con RLS

En `packages/ts-common/src/tenant/`: `TenantContext` basado en `AsyncLocalStorage` poblado por un interceptor desde el principal (auth) o desde el envelope en consumidores NATS; `requireTenant()` que lanza si falta. En `packages/ts-common/src/prisma-tenant/`: extensión de cliente Prisma (`$extends`) que envuelve cada operación de modelo en `$transaction` con `SELECT set_config('app.tenant_id', $1, true)` antes de la operación, reutilizando la transacción si ya existe una interactiva; `withSystemScope(fn)` explícito para operaciones de operador (usa un rol con `BYPASSRLS` solo si el servicio lo configura); y `createKysely(pool)` con un plugin que hace lo mismo para consultas Kysely (D8). Documentar en `README.md` cómo escribir la política RLS estándar del arch (*Data model → PostgreSQL*). No editar `package.json`. Cubre NFR-8 (Risks: Prisma + RLS).

Done when: un test de integración con Postgres (testcontainers) y una tabla con RLS demuestra que el tenant A no lee, actualiza ni borra filas del tenant B por Prisma ni por Kysely, que una operación sin tenant en contexto lanza error, y que operaciones anidadas dentro de `$transaction` mantienen el tenant.

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Aislamiento multi-tenant es un requisito de seguridad central y el riesgo Prisma + RLS está señalado en el arch.
- **Dependencies**: F0.5.T1
- **Files**:
  - `packages/ts-common/src/tenant/`
  - `packages/ts-common/src/prisma-tenant/`
  - `packages/ts-common/README.md`

### F0.5.T4 — Cliente NATS y auditoría

- `packages/ts-common/src/nats/`: `NatsModule.forRoot()` con `publish(type, tenantId, contactId, data)` que arma el envelope de C1 idéntico al de `libs/go/oe/natsx` (UUID v7, ms, `Nats-Msg-Id`, `trace_parent`) y `@OnEvent(stream, durable, filterSubject)` para consumidores durables pull con ack, nak con backoff y dead letter a `oe.system.dead_letter.<tenant>`. Usar los tipos generados en `@oe/ts-contracts` cuando existan.
- `packages/ts-common/src/audit/`: `AuditInterceptor` que, en toda petición de escritura (POST/PUT/PATCH/DELETE) exitosa bajo `/admin/v1` o `/api/v3`, registra `{tenant_id, actor_type, actor_id, action, resource_type, resource_id, diff, at}`. Destino configurable: en core un `AuditSink` que escribe directo en `identity.audit_log` (lo provee F0.6.T7); en el resto de servicios publica el evento `system.audit.recorded` en el stream `SYSTEM`. Escribir `contracts/events/system.audit.recorded.schema.json` y su ejemplo.

No editar `package.json`. Cubre FR-6, NFR-2.

Done when: tests con `nats-server` en contenedor verifican que un envelope publicado desde TS valida contra `contracts/events/envelope.schema.json`, que un consumidor recibe, nakea y termina en dead letter tras `maxDeliver`, y que el interceptor publica un evento de auditoría ante un POST exitoso y ninguno ante un GET o un 4xx.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Integración de mensajería e interceptores NestJS con contratos ya fijados; estándar.
- **Dependencies**: F0.5.T1
- **Files**:
  - `packages/ts-common/src/nats/`
  - `packages/ts-common/src/audit/`
  - `contracts/events/system.audit.recorded.schema.json`
  - `contracts/events/examples/system.audit.recorded.json`

### F0.5.T5 — keyring para Node con el mismo formato que Go

`packages/ts-common/src/keyring/`: misma API y mismo formato de sobre que `libs/go/oe/keyring` (F0.4.T5): `derive(purpose, tenantId)` con HKDF-SHA256 (`node:crypto`), y `seal`/`open` con AES-256-GCM. Lee `OE_MASTER_KEYS` y `OE_MASTER_KEY_ID`, y falla al arrancar si faltan. La usan campaigns (llaves DKIM), connectors (credenciales y secretos de webhooks) y cualquier servicio NestJS que guarde secretos. Sin dependencias nuevas. Cubre NFR-9.

Done when: `pnpm --filter ts-common test -- keyring` pasa con ida y vuelta, rotación y `kid` desconocido, y descifra el vector fijo `libs/go/oe/keyring/testdata/vectors.json` generado por Go.

- **Model**: claude/claude-opus-5
- **Estimate**: 1.5h
- **Reason**: Criptografía que debe ser compatible byte a byte con la implementación Go.
- **Dependencies**: F0.5.T1, F0.4.T5
- **Files**:
  - `packages/ts-common/src/keyring/`

## F0.6 — Package: core identity

### F0.6.T1 — Scaffold del servicio core

Crear `services/core` (NestJS 11, `@oe/core`) con `src/main.ts` (llama a `startOtel('core')` antes de crear la app, valida config, prefijos `/admin/v1`, `/api/v3`, `/internal/v1`), `src/app.module.ts` con `AuthModule`, `NatsModule`, `ProblemJsonFilter` y `AuditInterceptor` de `@oe/ts-common`, módulo `health` (`/healthz`, `/readyz` que chequea Postgres y NATS), Prisma con esquema multiarchivo (`prisma/schema/base.prisma` con datasource `postgresql` sobre el rol `core` y `previewFeatures` necesarias, C11), cliente Prisma extendido con `prisma-tenant`, `Dockerfile` multi-stage, `deploy/compose/services/core.yml` (perfil `core`, depende de postgres y nats, variables del `.env.example`) y configuración de tests (Jest + testcontainers). En `package.json` declarar el script `cli` (`tsx src/cli/main.ts`) que implementa F0.6.T3. Es la única tarea de F0.6 que edita `services/core/package.json`: declarar ya `@node-rs/argon2`, `otplib`, `nodemailer`, `jose`, `commander` y `tsx`. Cubre NFR-1, NFR-12.

Done when: `pnpm --filter @oe/core test` pasa, `docker compose -f deploy/compose/docker-compose.yml -f deploy/compose/services/core.yml up core` arranca y `/readyz` responde 200.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Scaffold NestJS estándar usando librerías ya construidas.
- **Dependencies**: F0.2.T1, F0.5.T2, F0.5.T3, F0.5.T4
- **Files**:
  - `services/core/package.json`
  - `services/core/tsconfig.json`
  - `services/core/src/main.ts`
  - `services/core/src/app.module.ts`
  - `services/core/src/modules/health/`
  - `services/core/prisma/schema/base.prisma`
  - `services/core/Dockerfile`
  - `services/core/jest.config.ts`
  - `deploy/compose/services/core.yml`

### F0.6.T2 — Esquema identity con RLS

> **Nota de F0.6.T1:** Prisma no genera cliente para un esquema sin modelos, así que F0.6.T1 no pudo crear el cliente Prisma extendido con `prisma-tenant`. Esta tarea lo añade junto con los primeros modelos: un provider global `PRISMA_CLIENT` con `withTenantScope(new PrismaClient())` en `services/core/src/prisma/`. El `/readyz` de health usa `pg` directamente y no depende de Prisma. El script `generate` de `services/core` ya se salta Prisma mientras no haya modelos y lo ejecuta en cuanto exista el primero.

Escribir `services/core/prisma/schema/identity.prisma` con las tablas de *Data model → core → identity* del arch: `tenants`, `users`, `roles`, `role_permissions`, `user_roles`, `api_clients`, `refresh_tokens`, `invitations` (token hash, email, roles, expires_at, accepted_at), `mfa_recovery_codes` y `audit_log`, todas en el schema `identity`, IDs UUID v7, `tenant_id` en toda tabla de negocio (null solo para usuarios operador). Generar la migración inicial y agregar SQL manual en la misma migración para: habilitar RLS y `FORCE ROW LEVEL SECURITY` en cada tabla con `tenant_id`, política `tenant_id = current_setting('app.tenant_id', true)::uuid`, índices únicos `(tenant_id, lower(email))` en usuarios, índice `(tenant_id, at desc)` en `audit_log`, y `audit_log` append-only (revocar UPDATE/DELETE al rol `core`). Seed mínimo del catálogo de módulos de permiso (`platform`, `identity`, `contacts`, `events`, `segments`, `email`, `campaigns`, `automation`, `predict`, `channels`, `analytics`, `loyalty`, `integrations`) como constante exportada en `src/modules/identity-shared/permissions.ts`. Cubre FR-1, FR-2, FR-6, NFR-8.

Done when: `prisma migrate deploy` sobre una base limpia aplica la migración, y un test de integración confirma que con `app.tenant_id` del tenant A no se ven usuarios del tenant B y que un UPDATE sobre `audit_log` falla.

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Modelo de datos de identidad y políticas RLS; errores comprometen el aislamiento de tenants.
- **Dependencies**: F0.6.T1
- **Files**:
  - `services/core/prisma/schema/identity.prisma`
  - `services/core/prisma/migrations/`
  - `services/core/src/modules/identity-shared/`

### F0.6.T3 — Tenants (operador)

Módulo `services/core/src/modules/tenants/` según `contracts/openapi/admin-v1/identity.yaml`: `GET/POST /admin/v1/tenants`, `GET/PATCH /admin/v1/tenants/{id}` solo para principal operador (`tenant_id` null y permiso `platform:admin`), con nombre, zona horaria IANA validada, idioma por defecto (`es|pt|en`), `limits` (contactos, eventos/día, envíos/día, llamadas API/min) y `status` (`active|suspended`). Crear un tenant crea sus roles por defecto (`Admin` con todos los permisos, `Marketer` con view/edit/launch en módulos de marketing, `Viewer` solo view) y publica `system.tenant.created`. Un tenant suspendido rechaza logins y tokens de API con 403. Usa `withSystemScope` solo en este módulo. Incluye el comando `pnpm --filter @oe/core cli create-operator --email --password` en `src/cli/` (bootstrap idempotente del primer operador, sin pasar por HTTP) para el seed. Cubre FR-1.

Done when: tests de integración verifican alta con roles por defecto, validación de zona horaria inválida (400 problem+json), que un usuario de tenant recibe 403 en estas rutas, y que un tenant suspendido no puede iniciar sesión.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: CRUD con reglas de autorización simples sobre contratos ya fijados.
- **Dependencies**: F0.6.T2
- **Files**:
  - `services/core/src/modules/tenants/`
  - `services/core/src/cli/`

### F0.6.T4 — Login, sesiones, MFA TOTP y emisión de JWT

Módulo `services/core/src/modules/auth/` (D7):
- Llaves RS256 cargadas desde `CORE_JWT_KEYS_DIR` (archivos PEM con `kid`), con soporte de 2 llaves activas para rotación; `GET /.well-known/jwks.json` público.
- `POST /admin/v1/auth/login`: verifica Argon2id (`@node-rs/argon2`, parámetros OWASP), mensaje de error idéntico para email desconocido y contraseña incorrecta, bloqueo de 15 min tras 5 fallos consecutivos (`failed_logins`, `locked_until`), tenant suspendido → 403. Si el usuario tiene MFA devuelve `{mfa_required: true, mfa_token}` (JWT de 5 min con `typ=mfa`).
- `POST /admin/v1/auth/mfa/verify`: TOTP (RFC 6238, ventana ±1) o código de recuperación de un solo uso.
- Emisión: access token JWT 15 min con `typ=user`, `tenant_id`, `perms` calculados de sus roles; refresh token opaco rotativo de 30 días (hash en `refresh_tokens`, reuso detectado revoca la familia). `POST /auth/refresh`, `POST /auth/logout`.
- `POST /admin/v1/me/mfa/enroll` (secreto cifrado con AES-GCM usando `CORE_ENCRYPTION_KEY`, URI otpauth), `/me/mfa/confirm` (activa y devuelve 10 códigos de recuperación), `DELETE /me/mfa` (requiere TOTP), `PATCH /me` (locale `es|pt|en`).
- Exporta `JwtSigner` para F0.6.T6.

Cubre FR-3, FR-5 (preferencia de idioma), NFR-9.

Done when: tests de integración cubren login correcto, contraseña incorrecta, bloqueo al 5.º fallo y desbloqueo a los 15 min (reloj simulado), login con MFA que exige código, código TOTP inválido, código de recuperación usado dos veces, rotación de refresh token y detección de reuso, y el JWKS verifica los tokens emitidos con `@oe/ts-common/auth`.

- **Model**: claude/claude-opus-5
- **Estimate**: 4h
- **Reason**: Autenticación, criptografía y manejo de sesiones; es el componente más sensible a seguridad de la fase.
- **Dependencies**: F0.6.T2
- **Files**:
  - `services/core/src/modules/auth/`

### F0.6.T5 — Usuarios, invitaciones y roles

Módulos `services/core/src/modules/users/` y `services/core/src/modules/roles/` según `contracts/openapi/admin-v1/identity.yaml`:
- Usuarios: `GET /users` paginado por cursor con búsqueda por email, `PATCH /users/{id}` (roles, nombre, desactivar), `DELETE /users/{id}` (no permite borrar el último `Admin` del tenant). Requieren `identity:admin` (listar con `identity:view`).
- Invitaciones: `POST /users/invitations` crea un token aleatorio de 32 bytes (se guarda solo el hash), válido 7 días, y envía email por SMTP (nodemailer contra Mailpit en desarrollo, `SMTP_URL` configurable) con enlace a `admin-web /[locale]/invite/{token}`; `POST /invitations/{token}/accept` fija contraseña (mínimo 12 caracteres, verificación contra lista de contraseñas comunes) y crea el usuario.
- Roles: CRUD con `permissions[{module, action}]` validados contra el catálogo de F0.6.T2; los roles por defecto no se borran; cambios de permisos se reflejan en el siguiente access token.

Cubre FR-2.

Done when: tests de integración verifican invitación → email en Mailpit (API de Mailpit) → aceptación → login; que un usuario con rol "Viewer" recibe 403 al crear un rol; que no se puede borrar el último Admin; y que un token de invitación expirado o reutilizado falla.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: CRUD con reglas de negocio claras; la criptografía sensible está aislada en auth.
- **Dependencies**: F0.6.T2
- **Files**:
  - `services/core/src/modules/users/`
  - `services/core/src/modules/roles/`

### F0.6.T6 — Credenciales de API y OAuth client credentials

Módulos `services/core/src/modules/api-clients/` y `services/core/src/modules/oauth/`:
- `GET/POST /admin/v1/api-clients` (requiere `identity:admin`): nombre y `scopes` (subconjunto de `module:action`); genera `client_id` y un `client_secret` de 32 bytes que se devuelve una sola vez (se guarda Argon2id); `POST /api-clients/{id}/revoke` marca `revoked_at`.
- `POST /api/v3/oauth/token` (C2, `application/x-www-form-urlencoded`, `grant_type=client_credentials`, credenciales por Basic o body): devuelve JWT de 1 h con `typ=client`, `tenant_id`, `scopes`; errores RFC 6749 (`invalid_client`, `unsupported_grant_type`); rate limit de 10 intentos fallidos por `client_id` por minuto.
- Tokens revocados: lista de `client_id` revocados publicada como evento `system.api_client.revoked` y consultable en `GET /internal/v1/revocations`, para que los verificadores rechacen tokens vigentes de clients revocados (documentar el TTL máximo de 1 h).
- Tokens de servicio: `POST /internal/v1/service-token` con credenciales por servicio desde `CORE_SERVICE_CREDENTIALS` (archivo), emite `typ=service`, 15 min.

Cubre FR-4, NFR-9.

Done when: tests de integración verifican token con scope `contacts:view` que accede a una ruta de prueba protegida con ese permiso y recibe 403 en otra; que tras revocar, `/oauth/token` responde `invalid_client` y un token previo es rechazado por el verificador que consulta revocaciones; y que el secret no aparece en ninguna respuesta posterior ni en logs.

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Flujo OAuth y manejo de secretos de API; sensible a seguridad.
- **Dependencies**: F0.6.T4
- **Files**:
  - `services/core/src/modules/api-clients/`
  - `services/core/src/modules/oauth/`

### F0.6.T7 — Audit log

Módulo `services/core/src/modules/audit/`: implementa el `AuditSink` de `@oe/ts-common/audit` que escribe en `identity.audit_log` para las escrituras de core, un consumidor durable `core-audit` del stream `SYSTEM` (`oe.system.audit.recorded.>`) que persiste los eventos de auditoría de otros servicios (idempotente por `id` del envelope), y `GET /admin/v1/audit-log` paginado por cursor con filtros `actor_id`, `resource_type`, `from`, `to` (requiere `identity:admin`). Los diffs nunca contienen contraseñas, secretos ni tokens: redactar claves `password`, `secret`, `token`, `mfa_*`. Cubre FR-6.

Done when: tests de integración verifican que borrar un usuario genera una entrada con actor, fecha, recurso y tenant; que un evento `system.audit.recorded` publicado dos veces genera una sola fila; que el diff de un cambio de contraseña aparece redactado; y que un admin del tenant A no ve entradas del tenant B.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Persistencia y consulta con reglas de redacción simples.
- **Dependencies**: F0.6.T2
- **Files**:
  - `services/core/src/modules/audit/`

### F0.6.T8 — Wiring de identity y tests de seguridad transversales

Registrar en `services/core/src/app.module.ts` los módulos `tenants`, `auth`, `users`, `roles`, `api-clients`, `oauth` y `audit` (única tarea que edita ese archivo en F0). Escribir la suite `services/core/test/security/` que corre contra la app completa con Postgres y NATS en testcontainers: (1) acceso cruzado — para cada ruta `/admin/v1` de identity, un usuario del tenant A con permisos completos intenta leer y modificar recursos del tenant B por ID y recibe 404 o 403, nunca datos (NFR-8); (2) matriz de permisos — cada ruta con `@RequirePermission` rechaza con 403 a un rol sin ese permiso (FR-2); (3) autenticación — rutas sin `@Public` rechazan sin token, con token expirado y con `typ=service` fuera de `/internal`; (4) headers — no se filtran stack traces en errores 500. Documentar la convención en `services/core/test/security/README.md` para que las fases siguientes agreguen sus rutas a la matriz.

Done when: `pnpm --filter @oe/core test:security` pasa y falla si se quita temporalmente la política RLS de `identity.users` (verificado a mano una vez, anotado en el README).

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Suite de seguridad que certifica el aislamiento multi-tenant y los permisos; requiere pensar como atacante.
- **Dependencies**: F0.6.T3, F0.6.T4, F0.6.T5, F0.6.T6, F0.6.T7
- **Files**:
  - `services/core/src/app.module.ts`
  - `services/core/test/security/`

## F0.7 — Package: admin-web shell

### F0.7.T1 — Scaffold de admin-web con i18n, layout y registro de navegación

Crear `apps/admin-web` (Next.js 15 App Router, React 19, TypeScript estricto, Tailwind 4, shadcn/ui con Radix) con:
- next-intl: locales `es` (default), `pt`, `en`; rutas bajo `src/app/[locale]/`; mensajes por feature en `messages/<locale>/<feature>.json` (C11) cargados y fusionados en `src/i18n/request.ts`; `messages/<locale>/common.json` con textos del shell; formateo de fechas, números y monedas con la zona horaria y el locale del usuario (NFR-16).
- Layout `src/app/[locale]/(console)/layout.tsx` con sidebar, header con selector de idioma y menú de usuario, y `src/app/[locale]/(auth)/layout.tsx` vacío para F0.7.T2.
- Registro de navegación (C11): cada feature exporta `NavItem[]` desde `src/nav/<feature>.ts` (label key, href, icono lucide, permiso requerido); `scripts/codegen/nav.mjs` genera `src/nav/index.ts` con imports de todos los archivos del directorio y corre en `predev`/`prebuild`; `src/nav/index.ts` va en `.gitignore`. El sidebar oculta ítems sin permiso.
- `src/lib/api/client.ts`: cliente tipado con `openapi-fetch` sobre los tipos de `@oe/ts-contracts`, que llama a `/admin/v1` vía el gateway y reenvía la cookie de sesión desde server components.
- Accesibilidad base (NFR-15): skip link, landmarks, foco visible, `eslint-plugin-jsx-a11y` y tests de componentes con `@testing-library/react` + `jest-axe`.
- `Dockerfile` (output standalone) y `deploy/compose/services/admin-web.yml` (perfil `core`).
- Única tarea de F0.7 que edita `apps/admin-web/package.json`: declarar ya las dependencias que usan F0.7.T2–T5 (`react-hook-form`, `zod`, `@hookform/resolvers`, `@tanstack/react-table`, `sonner`, `qrcode`, `msw`, `openapi-fetch`, `lucide-react`).

Cubre FR-5, NFR-15, NFR-16.

Done when: `pnpm --filter @oe/admin-web build` pasa, `pnpm --filter @oe/admin-web test` pasa con un test axe sin violaciones sobre el layout, y cambiar de `/es` a `/pt` traduce el shell sin perder la ruta actual.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Scaffold frontend con varias piezas estándar (Next, shadcn, next-intl) y un codegen sencillo.
- **Dependencies**: F0.3.T3
- **Files**:
  - `apps/admin-web/package.json`
  - `apps/admin-web/next.config.ts`
  - `apps/admin-web/tsconfig.json`
  - `apps/admin-web/Dockerfile`
  - `apps/admin-web/src/app/[locale]/layout.tsx`
  - `apps/admin-web/src/app/[locale]/(console)/layout.tsx`
  - `apps/admin-web/src/app/[locale]/(console)/page.tsx`
  - `apps/admin-web/src/app/[locale]/(auth)/layout.tsx`
  - `apps/admin-web/src/i18n/`
  - `apps/admin-web/src/nav/types.ts`
  - `apps/admin-web/src/components/ui/`
  - `apps/admin-web/src/components/shell/`
  - `apps/admin-web/src/lib/api/`
  - `apps/admin-web/messages/es/common.json`
  - `apps/admin-web/messages/pt/common.json`
  - `apps/admin-web/messages/en/common.json`
  - `scripts/codegen/nav.mjs`
  - `deploy/compose/services/admin-web.yml`

### F0.7.T2 — Flujo de autenticación en la consola

- Páginas `src/app/[locale]/(auth)/login/`, `(auth)/mfa/`, `(auth)/invite/[token]/` (aceptar invitación y fijar contraseña) según `contracts/openapi/admin-v1/identity.yaml`.
- Route handlers `src/app/api/auth/{login,mfa,refresh,logout}/route.ts` que llaman a core y guardan access y refresh token en cookies `httpOnly`, `Secure` (fuera de dev), `SameSite=Lax`, con path acotado para el refresh; el navegador nunca ve los tokens en JS.
- `src/middleware.ts` que combina next-intl con la protección de `(console)`: sin sesión redirige a `/[locale]/login?next=`, refresca el access token si expiró y valida `next` como ruta relativa (evita open redirect).
- Protección CSRF en los route handlers de escritura (cabecera `Origin` + token doble submit).
- Página `src/app/[locale]/(console)/profile/security/` para activar y desactivar MFA (QR del URI otpauth, códigos de recuperación mostrados una vez) y cambiar idioma preferido.
- Mensajes en `messages/<locale>/auth.json`. Mensajes de error sin distinguir email inexistente de contraseña incorrecta; aviso de cuenta bloqueada.

Cubre FR-3, FR-5, NFR-9, NFR-15.

Done when: tests de componentes cubren los formularios con axe sin violaciones, y un test de integración con core simulado (MSW) verifica login con y sin MFA, redirección de `(console)` sin sesión, rechazo de `next=https://evil.com` y que las cookies son `httpOnly`.

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Manejo de sesión, cookies, CSRF y redirecciones en el frontend; sensible a seguridad.
- **Dependencies**: F0.7.T1
- **Files**:
  - `apps/admin-web/src/app/[locale]/(auth)/login/`
  - `apps/admin-web/src/app/[locale]/(auth)/mfa/`
  - `apps/admin-web/src/app/[locale]/(auth)/invite/`
  - `apps/admin-web/src/app/api/auth/`
  - `apps/admin-web/src/app/[locale]/(console)/profile/`
  - `apps/admin-web/src/middleware.ts`
  - `apps/admin-web/src/lib/session/`
  - `apps/admin-web/messages/es/auth.json`
  - `apps/admin-web/messages/pt/auth.json`
  - `apps/admin-web/messages/en/auth.json`

### F0.7.T3 — Pantallas del operador: tenants

Sección `src/app/[locale]/(console)/platform/tenants/` visible solo con permiso `platform:admin`: listado paginado con estado, alta y edición (nombre, zona horaria con buscador IANA, idioma por defecto, límites numéricos, suspender/reactivar con confirmación). Formularios con react-hook-form + zod derivado de los tipos generados, estados vacío/carga/error y toasts. Navegación en `src/nav/platform.ts`, mensajes en `messages/<locale>/platform.json`. Tests con MSW contra el contrato. Cubre FR-1, NFR-15, NFR-16.

Done when: tests de componentes verifican alta de tenant con validación de zona horaria, suspensión con confirmación y ausencia de violaciones axe, y el ítem de navegación no aparece para un usuario sin `platform:admin`.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Pantallas CRUD estándar sobre un contrato ya definido.
- **Dependencies**: F0.7.T1
- **Files**:
  - `apps/admin-web/src/app/[locale]/(console)/platform/`
  - `apps/admin-web/src/nav/platform.ts`
  - `apps/admin-web/messages/es/platform.json`
  - `apps/admin-web/messages/pt/platform.json`
  - `apps/admin-web/messages/en/platform.json`

### F0.7.T4 — Pantallas de usuarios y roles

Sección `src/app/[locale]/(console)/settings/users/` (listado con búsqueda, invitar por email con roles, editar roles, desactivar, borrar con confirmación) y `src/app/[locale]/(console)/settings/roles/` (listado, editor de permisos como matriz módulo × acción con checkboxes accesibles por teclado, roles por defecto no borrables). Errores del backend (último admin, email duplicado) mostrados en el idioma del usuario. Navegación en `src/nav/settings.ts`, mensajes en `messages/<locale>/settings.json`. Tests con MSW. Cubre FR-2, NFR-15.

Done when: tests de componentes verifican invitar usuario, editar la matriz de permisos solo con teclado y el error "no se puede borrar el último Admin", sin violaciones axe.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: UI CRUD con una matriz de permisos; estándar con atención a accesibilidad.
- **Dependencies**: F0.7.T1
- **Files**:
  - `apps/admin-web/src/app/[locale]/(console)/settings/`
  - `apps/admin-web/src/nav/settings.ts`
  - `apps/admin-web/messages/es/settings.json`
  - `apps/admin-web/messages/pt/settings.json`
  - `apps/admin-web/messages/en/settings.json`

### F0.7.T5 — Pantallas de credenciales de API y audit log

Sección `src/app/[locale]/(console)/developer/credentials/`: listado de API clients, alta con nombre y selección de scopes, diálogo que muestra `client_id` y `client_secret` una sola vez con botón copiar y aviso, revocación con confirmación, y un bloque con el ejemplo `curl` de `POST /api/v3/oauth/token`. Sección `src/app/[locale]/(console)/developer/audit/`: tabla paginada por cursor con filtros por actor, tipo de recurso y rango de fechas, y detalle del diff. Navegación en `src/nav/developer.ts`, mensajes en `messages/<locale>/developer.json`. Tests con MSW. Cubre FR-4, FR-6, NFR-15.

Done when: tests de componentes verifican que el secret se muestra solo en el diálogo de creación y no tras recargar, la revocación con confirmación, y los filtros del audit log, sin violaciones axe.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Pantallas estándar con un cuidado puntual sobre la exposición del secret.
- **Dependencies**: F0.7.T1
- **Files**:
  - `apps/admin-web/src/app/[locale]/(console)/developer/`
  - `apps/admin-web/src/nav/developer.ts`
  - `apps/admin-web/messages/es/developer.json`
  - `apps/admin-web/messages/pt/developer.json`
  - `apps/admin-web/messages/en/developer.json`

## F0.8 — Package: gateway y seed

### F0.8.T1 — Cierre de F0: plataforma levantada y e2e en verde

Gate de fase. Levantar la plataforma completa desde un clon limpio con `make up` (perfiles `core`, `data`, `obs`) + `make seed`, correr `make e2e` (suite de F0.8.T4) y la suite de seguridad de core, corregir los defectos de integración que aparezcan dentro de los archivos listados, y dejar `tests/e2e/platform/CHECKLIST.md` con cada FR-1..FR-6 y NFR-8, NFR-12, NFR-13 (parcial), NFR-15 marcados con el test o la verificación manual que los prueba y el resultado. Medir y anotar el tiempo de `make up` en un host limpio (NFR-13, objetivo < 10 min). Verificar en Grafana que core y admin-web emiten trazas (NFR-12).

Done when: en un clon limpio, `make up && make seed && make e2e` termina en 0, `CHECKLIST.md` no tiene ítems pendientes y el job de CI está en verde.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Integración y verificación de lo ya construido; no requiere diseño nuevo.
- **Dependencies**: F0.8.T4, F0.4.T2, F0.4.T3, F0.4.T4, F0.5.T5
- **Files**:
  - `tests/e2e/platform/CHECKLIST.md`

### F0.8.T2 — Rutas del gateway e inclusión de servicios en compose

- Editar `deploy/compose/docker-compose.yml` para incluir `deploy/compose/services/core.yml` y `deploy/compose/services/admin-web.yml`.
- `deploy/traefik/dynamic/core.yml`: `/admin/v1/{auth,me,tenants,users,invitations,roles,api-clients,audit-log}` y `/api/v3/oauth/token` y `/.well-known/jwks.json` hacia core, con middlewares `secure-headers`, `ratelimit-ip` (login y oauth: 10 req/min por IP) y `ratelimit-tenant`. `/internal/*` nunca se expone por el gateway (regla explícita que responde 404).
- `deploy/traefik/dynamic/admin-web.yml`: todo lo demás (`/`) hacia admin-web con menor prioridad.

Cubre NFR-9.

Done when: con la plataforma arriba, `curl -i localhost:8080/.well-known/jwks.json` responde 200 desde core, `curl -i localhost:8080/internal/v1/service-token` responde 404, y 11 POST seguidos a `/admin/v1/auth/login` desde la misma IP devuelven 429 en el último.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 1.5h
- **Reason**: Configuración declarativa de rutas y middlewares ya definidos.
- **Dependencies**: F0.2.T3, F0.6.T1, F0.7.T1
- **Files**:
  - `deploy/compose/docker-compose.yml`
  - `deploy/traefik/dynamic/core.yml`
  - `deploy/traefik/dynamic/admin-web.yml`

### F0.8.T3 — Seed de plataforma

`scripts/seed/run.sh` como punto de entrada único (`make seed`) que ejecuta en orden los seeds de cada fase presentes en `scripts/seed/*/seed.*` (cada fase agrega su directorio; el orden es alfabético por nombre de directorio con prefijo numérico). `scripts/seed/00-platform/seed.ts` (tsx) idempotente que, vía la API de core y con credenciales de operador bootstrap desde env: crea el usuario operador, el tenant demo "Tienda Demo" (America/Sao_Paulo, es) con sus roles por defecto, un Admin (`admin@demo.local`), un Marketer y un Viewer con contraseñas de `.env.example`, y un API client de demo con todos los scopes cuyo secret se escribe en `.env.local` (gitignored). El operador se crea con `pnpm --filter @oe/core cli create-operator` (F0.6.T3). Cubre NFR-13.

Done when: `make seed` corre dos veces seguidas sin error ni duplicados, y después se puede iniciar sesión en la consola como `admin@demo.local`.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Script idempotente contra una API existente; estándar.
- **Dependencies**: F0.6.T8
- **Files**:
  - `scripts/seed/run.sh`
  - `scripts/seed/00-platform/`

### F0.8.T4 — Suite e2e de plataforma

Proyecto `tests/e2e` (Playwright + `@axe-core/playwright`, `package.json` propio) y suite `tests/e2e/platform/` contra la plataforma levantada con el seed: (1) login correcto, contraseña incorrecta y bloqueo al 5.º intento (FR-3); (2) activar MFA con TOTP calculado en el test y login con código (FR-3); (3) operador crea un tenant y su admin no ve datos del tenant demo (FR-1, NFR-8); (4) admin invita a un usuario, lo acepta vía enlace leído de la API de Mailpit, le asigna "Viewer" y ese usuario recibe 403 al intentar crear un rol (FR-2); (5) crear API client, obtener token por `/api/v3/oauth/token`, usarlo, revocarlo y verificar rechazo (FR-4); (6) cambiar idioma a `pt` y `en` y verificar navegación y formularios traducidos (FR-5); (7) borrar un usuario y verlo en el audit log (FR-6); (8) axe sin violaciones serias en login, dashboard, usuarios, roles, credenciales y audit (NFR-15). `tests/e2e/run.sh` corre todas las suites presentes en `tests/e2e/*/`.

Done when: `make e2e` pasa los 8 escenarios con la plataforma de F0.8.T2 y el seed de F0.8.T3.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Tests de punta a punta sobre flujos definidos; estándar pero extensos.
- **Dependencies**: F0.8.T2, F0.8.T3, F0.7.T2, F0.7.T3, F0.7.T4, F0.7.T5
- **Files**:
  - `tests/e2e/package.json`
  - `tests/e2e/playwright.config.ts`
  - `tests/e2e/run.sh`
  - `tests/e2e/platform/`
