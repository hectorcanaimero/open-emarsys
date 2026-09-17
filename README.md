# Open Emarsys — Plataforma de Marketing Omnicanal

Clon de código abierto de Emarsys, una plataforma de marketing omnicanal construida con Go, TypeScript y Python. Soporta gestión de contactos, segmentación, campañas de email, automatización, análisis y lealtad en tiempo real.

## Requisitos

- **Docker** 24.x+ (Compose 2.20+)
- **pnpm** 9.x
- **Go** 1.24
- **uv** 0.50+
- **Node** 22.x

## Layout del monorepo

```
.
├── apps/
│   ├── admin-web/              # Consola de administración (Next.js)
│   └── public-api/             # API pública (app Next.js con rutas API)
├── packages/
│   ├── ts-contracts/           # Tipos generados desde contratos (OpenAPI, Protobuf)
│   └── ts-common/              # Librerías compartidas NestJS (@oe/ts-common)
├── services/
│   ├── core/                   # Identidad, autenticación y permisos (NestJS)
│   ├── contacts/               # Base de contactos (NestJS)
│   ├── events/                 # Ingestor de eventos (Go)
│   ├── segments/               # Segmentación (NestJS)
│   ├── email/                  # Motor de email (Go)
│   ├── campaigns/              # Orquestación de campañas (NestJS)
│   ├── automation/             # Automation center (NestJS)
│   ├── connectors/             # Integraciones externas (NestJS)
│   ├── ml/                     # ML (Python con uv)
│   └── genai/                  # GenAI (Python con uv)
├── libs/
│   ├── go/oe/                  # Librerías compartidas Go
│   │   ├── config/             # Configuración desde env
│   │   ├── log/                # Logging JSON
│   │   ├── otel/               # OpenTelemetry
│   │   ├── httpx/              # HTTP server con middlewares
│   │   ├── tenant/             # Aislamiento multi-tenant
│   │   ├── natsx/              # Mensajería NATS
│   │   ├── auth/               # Verificación de JWT
│   │   ├── pg/                 # PostgreSQL con RLS
│   │   ├── chx/                # ClickHouse
│   │   └── keyring/            # Cifrado
├── contracts/
│   ├── events/                 # Esquemas JSON Schema para eventos NATS
│   └── openapi/                # Contratos OpenAPI 3.1
├── deploy/
│   ├── compose/                # Docker Compose (PostgreSQL, Redis, etc.)
│   ├── traefik/                # Gateway y middlewares
│   ├── postgres/               # Migraciones SQL
│   ├── nats/                   # Configuración NATS
│   ├── clickhouse/             # ClickHouse y migraciones
│   └── observability/          # OpenTelemetry, Grafana, Prometheus
├── tests/
│   └── e2e/                    # Tests de punta a punta (Playwright)
├── docs/
│   ├── arch/                   # Arquitectura
│   ├── prd/                    # Product Requirements
│   └── ops/                    # Operaciones (runbooks, rotación de claves)
├── scripts/
│   ├── codegen/                # Generación de código desde contratos
│   └── seed/                   # Scripts de seeding
├── proto/                      # Protocol Buffers (para gRPC interno, C5)
└── Makefile                    # Targets de desarrollo
```

## Guía de inicio rápido

### Desarrollo

```bash
# Instalar dependencias
pnpm install

# Levantar infraestructura (Postgres, Redis, NATS, etc.)
make up

# Seed de demo (operador, tenant demo, usuarios)
make seed

# Ejecutar tests
make test

# Linting de todo el código
make lint

# Validar contratos
make contracts

# Generar TypeScript/Go desde contratos
make codegen

# E2E en local
make e2e
```

### Docker

```bash
# Construir solo core
docker build -t oe-core services/core/

# Con compose
docker compose -f deploy/compose/docker-compose.yml --profile core up -d
```

## Targets de Makefile

| Target    | Descripción                                          | Script/Comando                                     |
|-----------|------------------------------------------------------|----------------------------------------------------|
| `up`      | Levanta infraestructura local                        | `docker compose -f deploy/compose/docker-compose.yml up -d` |
| `down`    | Detiene infraestructura                              | `docker compose down`                              |
| `seed`    | Seed de datos (demo, usuarios)                       | `scripts/seed/run.sh`                              |
| `e2e`     | Tests de punta a punta                               | `tests/e2e/run.sh`                                 |
| `lint`    | Lint: turbo (TS) + golangci (Go) + ruff (Python)    | `pnpm turbo lint` + linters                        |
| `test`    | Tests unitarios (turbo)                              | `pnpm turbo run test`                              |
| `contracts` | Valida esquemas y contratos                        | `node scripts/codegen/validate-contracts.mjs`     |
| `codegen` | Genera TS/Go desde contratos                         | `node scripts/codegen/gen.mjs`                     |
| `bench`   | Benchmarks                                           | `scripts/bench/run.sh`                             |

## Herramientas por lenguaje

**TypeScript/JavaScript:**
- Monorepo: pnpm + Turborepo
- Linting/Formato: Biome
- Generación: openapi-typescript, json-schema-to-typescript
- Framework backend: NestJS 11
- Framework frontend: Next.js 15
- Testing: Jest + testcontainers
- Contratos: OpenAPI 3.1

**Go:**
- Workspace: go.work
- Linting: golangci-lint (govet, staticcheck, errcheck, revive)
- Módulos: libs/go/oe
- Logging: slog (JSON)
- Mensajería: NATS JetStream
- ORM: pgx (Postgres), clickhouse-go (ClickHouse)
- gRPC: Connect
- Observabilidad: OpenTelemetry

**Python:**
- Workspace: uv
- Linting: ruff
- Testing: pytest
- ML: scikit-learn, pandas
- API: FastAPI (futuro)

## Configuración

Todas las variables de entorno se cargan desde `.env.local` (gitignored):

```bash
# Copiar plantilla
cp deploy/compose/.env.example .env.local

# Editar con valores locales
```

Variables principales:
- `CORE_JWT_KEYS_DIR` — Directorio con llaves RS256 para emitir JWT
- `OE_MASTER_KEYS` — Anillo de claves maestras para cifrado
- `SMTP_URL` — URL SMTP para invitaciones (Mailpit en dev)
- Perfiles de observabilidad (Prometheus, Tempo, Loki, Grafana)

## Convenciones de código

- **Tenant isolation**: Siempre pasar `tenant_id` en contextos, usar `app.tenant_id` en Postgres (RLS)
- **Eventos NATS**: Subject `oe.<type>.<tenant_id>`, schema en `contracts/events/`
- **Errores**: Respuestas JSON con `replyCode` (TS/Go) o `application/problem+json` (RFC 9457, admin)
- **Permisos**: `module:action` (ej: `contacts:view`, `campaigns:edit`)
- **Logs**: JSON con `trace_id`, `tenant_id`, `service` estructurados

## CI/CD

- GitHub Actions: `.github/workflows/ci.yml` — lint, test, contratos por cambio
- Cada PR valida contratos, tipos y tests pasan antes de merge

## Documentación adicional

- [Arquitectura](docs/arch/001-open-emarsys.md) — Diseño del sistema, componentes C1-C11, data model
- [PRD](docs/prd/001-open-emarsys.md) — Funcionalidades, fases, requisitos no-funcionales
- [Operaciones](docs/ops/) — Runbooks, rotación de claves, troubleshooting
