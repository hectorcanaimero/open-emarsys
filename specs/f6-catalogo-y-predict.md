---
type: spec
project_id: open-emarsys
phase: 6
version: 0.1
depends_on:
  - docs/arch/001-open-emarsys.md
  - docs/prd/001-open-emarsys.md
consumed_by:
  - orch-atomizer
generated_by: orch-spec
generated_at: 2026-09-17
title: Catálogo y Predict
---

# F6 — Catálogo y Predict

Milestone M6 del PRD: catálogo de productos, recomendaciones en email y web, churn, CLV, ciclo de vida, send time optimization y versionado de modelos (FR-47 a FR-53, NFR-7, NFR-17). Se entrena en Python (`services/ml`) y se sirve en Go (`services/scorer`, `services/personalize`), según D10 del arch. Todas las tareas de contratos dependen del cierre de F5 (F5.6.T1).

## F6.1 — Package: contracts predict

### F6.1.T1 — proto scorer.v1 y formato de artefactos de modelo

Escribir `proto/scorer/v1/scorer.proto` con el servicio `Scorer` exactamente como lo fija C5 del arch: `Score(ScoreRequest{tenant_id, contact_id, kinds[]})` → `ScoreReply{churn, clv, best_hour, lifecycle, model_versions map}` y `Recommend(RecommendRequest{tenant_id, logic, contact_id?, item_id?, cart[], filters{category, price_min, price_max, available}, limit})` → `RecommendReply{items[{item_id, score, title, url, image, price, currency}], model_version, rec_id}`. `logic` es un enum: `PERSONAL`, `RELATED`, `CART`, `POPULAR`, `RECENTLY_VIEWED` (FR-48). Documentar en `contracts/dsl/model-artifacts.md` el layout en MinIO `models/<tenant>/<kind>/<version>/`: `manifest.json` (kind, version, trained_at, features[], metrics, files), `model.onnx` para churn/CLV (nombres de input/output fijos), `item_item.parquet` (item_id, neighbor_id, score) y `als_factors.npz` para recs, `sto.parquet` (contact_id, best_hour) y `lifecycle.parquet`. Correr el codegen de F0.3 (`make codegen`) para generar los stubs Go/TS en el destino que define `proto/buf.gen.yaml`.

Cubre: FR-48, FR-50, FR-52 (contrato).

Done when: `buf lint proto` y `buf breaking` pasan, `make codegen` genera los stubs sin diff pendiente y el manifest de ejemplo en `contracts/dsl/model-artifacts.md` valida contra el JSON Schema embebido en el mismo documento.

- **Model**: claude/claude-opus-5
- **Estimate**: 2h
- **Reason**: Contrato que comparten Python, Go y TS; un error acá rompe tres servicios.
- **Dependencies**: F5.6.T1
- **Files**:
  - `proto/scorer/v1/scorer.proto`
  - `contracts/dsl/model-artifacts.md`

### F6.1.T2 — OpenAPI de catálogo y recomendaciones, eventos catalog.* y ml.*

Escribir `contracts/openapi/catalog.yaml` con las rutas de C2 para F6: `PUT /api/v3/catalog/items` (stream de hasta 1.000 ítems por llamada con id, título, URL, imagen, precio, moneda, `category_path[]`, marca, disponibilidad y `attrs`), `POST /api/v3/catalog/items/delete` y `GET /api/v3/recommendations` (logic, contact_id | external key, item_id, cart, filtros, limit), todo con el envelope `replyCode/replyText/data` y errores por ítem de C2. Agregar el endpoint público del widget `GET /p/v1/recs` (auth por `tenant_key` público como en C10). No hay endpoint propio de eventos: las impresiones y clicks van por `/c/v1/collect` como `behavior.tracked` kind `custom` con `props.name` = `oe_rec_impression` | `oe_rec_click` y `props.rec_id`; documentarlo en el mismo archivo. Esquemas de eventos (C1): `catalog.product.upserted`, `catalog.product.deleted`, `ml.model.trained` y `ml.model.activated` con `model_id, kind, version, artifact_uri, metrics`, más un ejemplo por evento en `contracts/events/examples/`.

Cubre: FR-47, FR-48, FR-49, FR-52, FR-53 (contrato).

Done when: la validación de contratos de CI (F0.3) pasa con los cuatro esquemas y sus ejemplos, y `openapi lint` (el linter configurado en F0.3) no reporta errores en `catalog.yaml`.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2.5h
- **Reason**: Contrato REST y de eventos siguiendo convenciones ya fijadas en C1/C2; no requiere diseño nuevo.
- **Dependencies**: F5.6.T1
- **Files**:
  - `contracts/openapi/catalog.yaml`
  - `contracts/events/catalog.product.upserted.schema.json`
  - `contracts/events/catalog.product.deleted.schema.json`
  - `contracts/events/ml.model.trained.schema.json`
  - `contracts/events/ml.model.activated.schema.json`
  - `contracts/events/examples/catalog.product.upserted.json`
  - `contracts/events/examples/catalog.product.deleted.json`
  - `contracts/events/examples/ml.model.trained.json`
  - `contracts/events/examples/ml.model.activated.json`

### F6.1.T3 — kind score en el DSL de segmentos

Extender `contracts/dsl/segment.schema.json` (C6) con el criterio `{ "kind": "score", "score": "churn"|"clv"|"best_hour"|"lifecycle", "cmp": "eq"|"neq"|"gt"|"gte"|"lt"|"lte"|"in", "value": number|string|array }`, donde `lifecycle` solo admite `eq`, `neq` e `in` con valores `new`, `active`, `at_risk`, `lapsed`, `churned`. Agregar fixtures válidos e inválidos en `contracts/dsl/fixtures/segments/` (un fixture por comparación y dos combinados con criterios de comportamiento).

Cubre: FR-50 (usable como criterio de segmento).

Done when: el validador de fixtures de CI acepta los válidos y rechaza los inválidos, y los fixtures de F3 siguen validando.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 1.5h
- **Reason**: Extensión acotada de un JSON Schema existente.
- **Dependencies**: F5.6.T1
- **Files**:
  - `contracts/dsl/segment.schema.json`
  - `contracts/dsl/fixtures/segments/score-churn-gte.json`
  - `contracts/dsl/fixtures/segments/score-lifecycle-in.json`
  - `contracts/dsl/fixtures/segments/score-combined-behavior.json`
  - `contracts/dsl/fixtures/segments/invalid-score-lifecycle-gt.json`

### F6.1.T4 — OpenAPI admin de Predict (catálogo, registro de modelos, scores)

Escribir `contracts/openapi/admin-v1/predict.yaml` según las convenciones de C3 (JSON plano, RFC 9457, cursor). Rutas y dueños: core `GET /admin/v1/catalog/items`, `GET /admin/v1/catalog/items/{item_id}`, `GET|PUT /admin/v1/catalog/feed` (URL, agenda cron, mapeo de columnas; lo ejecuta importer); ml `GET /admin/v1/predict/models?kind`, `POST /admin/v1/predict/models/{id}/activate`, `POST /admin/v1/predict/train` (`{kind}`, devuelve job); core `GET /admin/v1/contacts/{id}/scores` (lee `contact_scores` en ClickHouse); personalize `GET /admin/v1/predict/widgets/stats?from&to` (impresiones, clicks, CTR, revenue atribuido por widget). Permisos por módulo `predict:view|edit|admin`.

Cubre: FR-47, FR-50, FR-52, FR-53 (contrato de consola).

Done when: el linter OpenAPI de CI pasa y `packages/ts-contracts` regenera el cliente tipado sin errores de compilación.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 1.5h
- **Reason**: Contrato de consola con convenciones ya fijadas.
- **Dependencies**: F5.6.T1
- **Files**:
  - `contracts/openapi/admin-v1/predict.yaml`

### F6.1.T5 — Slots de recomendaciones en personalización y content versions

Extender C8 (`contracts/dsl/personalization.md`) y el contrato interno de content versions (C4, `contracts/openapi/internal/content.yaml`) para los bloques de productos. Cada `content_version` suma `recs_slots: [{name, logic, filters{category, price_min, price_max, available}, limit}]`. El Liquid compilado usa `{% for p in recs.<name> %}` con `p.title`, `p.url`, `p.image`, `p.price` (filtro `money`) y `p.rec_id`. El dispatcher resuelve todos los slots de un mensaje con una llamada `Recommend` por slot antes de renderizar. Si un slot vuelve vacío, el bloque renderiza su contenido de fallback (`{% if recs.<name> == empty %}`). Agregar fixtures de render en `contracts/dsl/fixtures/render/recs-*` (entrada: versión + contexto con recs resueltos; salida esperada: HTML).

Cubre: FR-49 (contrato).

Done when: los fixtures nuevos pasan la validación de estructura de CI y el documento describe nombres de slot válidos (`[a-z0-9_]{1,32}`) y el comportamiento con slot vacío.

- **Model**: claude/claude-opus-5
- **Estimate**: 2h
- **Reason**: Contrato entre content (Node), dispatcher (Go) y el editor; decide cómo se evita la divergencia de render (riesgo del arch).
- **Dependencies**: F5.6.T1
- **Files**:
  - `contracts/dsl/personalization.md`
  - `contracts/openapi/internal/content.yaml`
  - `contracts/dsl/fixtures/render/recs-personal.json`
  - `contracts/dsl/fixtures/render/recs-empty-fallback.json`

## F6.2 — Package: core catalog

### F6.2.T1 — Módulo catalog en core

Crear el módulo `catalog` en core (C11: `src/modules/catalog/`, esquema Prisma `prisma/schema/catalog.prisma`) con la tabla `catalog.products` del Data model del arch (RLS por `tenant_id` con la extensión de `ts-common`). Implementar `PUT /api/v3/catalog/items` (upsert por `item_id`, lotes de hasta 1.000, errores por índice), `POST /api/v3/catalog/items/delete` (soft delete con `deleted_at`), las rutas admin de catálogo de `admin-v1/predict.yaml` y la configuración de feed (`GET|PUT /admin/v1/catalog/feed`, guardada en `catalog.feeds`). Cada upsert o borrado publica `catalog.product.upserted` o `catalog.product.deleted` (C1) en NATS. No registrar el módulo en `app.module.ts`: lo hace el cierre de fase F6.7.T1.

Cubre: FR-47.

Done when: los tests de integración del módulo (Postgres y NATS de Compose) cubren upsert en lote con ítems inválidos, borrado, publicación de ambos eventos y acceso cruzado entre tenants rechazado (NFR-8).

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: CRUD NestJS con patrones ya establecidos en contacts (F1.2).
- **Dependencies**: F6.1.T2, F6.1.T4
- **Files**:
  - `services/core/src/modules/catalog/`
  - `services/core/prisma/schema/catalog.prisma`
  - `services/core/prisma/migrations/`

### F6.2.T2 — Réplica de productos, contact_scores y caché de disponibilidad

Agregar las migraciones ClickHouse `0600_products_replica.sql` (`products_replica` como `ReplacingMergeTree(updated_at)` ordenada por `(tenant_id, item_id)`, con columna `deleted`) y `0601_contact_scores.sql` (tabla `contact_scores` del Data model, `ReplacingMergeTree(updated_at)` ordenada por `(tenant_id, contact_id)`). En `collector/cmd/sink` sumar un consumidor durable `sink-catalog` sobre el stream `CATALOG` que escribe por lotes en `products_replica` y mantiene en Redis `cat:<tenant>:<item_id>` (hash con available, price, category_path; se borra al recibir `deleted`). Registrar el consumidor en `cmd/sink/main.go`.

Cubre: FR-47 (borrado reflejado en recomendaciones < 5 min), FR-50 (tabla de scores).

Done when: `go test ./...` en `services/collector` pasa con un test de integración que publica upsert + delete y verifica la fila en ClickHouse y la clave Redis creada y luego eliminada, y las migraciones se aplican sobre un ClickHouse limpio.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Consumidor que sigue el patrón de sinks de F2.2.
- **Dependencies**: F6.1.T2
- **Files**:
  - `deploy/clickhouse/migrations/0600_products_replica.sql`
  - `deploy/clickhouse/migrations/0601_contact_scores.sql`
  - `services/collector/internal/sink/products.go`
  - `services/collector/internal/sink/products_test.go`
  - `services/collector/cmd/sink/main.go`

### F6.2.T3 — Feed de catálogo programado en importer

Agregar a importer el job `catalog_feed`: lee la configuración de feed (URL HTTP(S) o `s3://imports/...`, cron, mapeo de columnas) desde core, descarga el CSV en streaming, mapea columnas y envía lotes de 1.000 a `PUT /api/v3/catalog/items` con token de servicio. Con `mode=full`, borra al final los ítems que no vinieron en el feed. Guarda progreso y errores en `importer.jobs` como los imports de F1.4. Programar con el scheduler existente de importer y registrarlo en `cmd/importer/main.go`.

Cubre: FR-47 (feed CSV programado).

Done when: un test de integración con un CSV de 10.000 productos servido por `httptest` termina con el job en `succeeded`, 10.000 llamadas a un stub de la API de core agrupadas en 10 lotes, y un segundo feed `full` con 9.990 ítems genera un borrado de 10.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Reutiliza el pipeline CSV streaming de F1.4.
- **Dependencies**: F6.1.T2, F6.1.T4
- **Files**:
  - `services/importer/internal/catalogfeed/`
  - `services/importer/cmd/importer/main.go`

## F6.3 — Package: ml training

### F6.3.T1 — Scaffold del proyecto ml

Crear `services/ml` como miembro del workspace `uv` (A6): `pyproject.toml` con Python 3.11+, dependencias `polars`, `clickhouse-connect`, `psycopg[binary]`, `minio`, `nats-py`, `implicit`, `lightgbm`, `onnxmltools`, `onnxruntime`, `fastapi`, `uvicorn`, `opentelemetry-sdk` y `pytest`. Paquete `src/ml` con `config.py` (env vars), clientes en `io/` (ClickHouse, Postgres con `SET LOCAL app.tenant_id`, MinIO, NATS con el envelope de C1) y OTel (NFR-12). Migración SQL `migrations/0001_models.sql` para el schema `ml` (tabla `models` del Data model, RLS). Dockerfile multi-stage. Agregar el miembro al `pyproject.toml` raíz. Ningún paquete depende de APIs pagas (NFR-17).

Cubre: NFR-17, NFR-12.

Done when: `uv sync` y `uv run pytest services/ml` pasan con un smoke test de cada cliente contra los servicios de Compose, y `docker build services/ml` termina.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Scaffold con clientes de infraestructura y RLS; algo más que boilerplate.
- **Dependencies**: F6.1.T1, F6.1.T2
- **Files**:
  - `services/ml/pyproject.toml`
  - `services/ml/src/ml/__init__.py`
  - `services/ml/src/ml/config.py`
  - `services/ml/src/ml/io/`
  - `services/ml/migrations/0001_models.sql`
  - `services/ml/Dockerfile`
  - `services/ml/tests/test_smoke.py`
  - `pyproject.toml`

### F6.3.T2 — Extracción de features desde ClickHouse

Implementar `ml.features`: funciones puras sobre polars que, para un tenant y una fecha de corte, extraen de ClickHouse (`events`, `orders`, `message_events`, `contacts_replica FINAL` excluyendo `deleted=1`, NFR-10): matriz de interacciones contacto×ítem con pesos (vista 1, carrito 3, compra 5, con decaimiento temporal); features por contacto para churn/CLV (recencia, frecuencia, monto, días desde la última apertura, tasa de clicks 90 d, tendencia de compras); histograma de aperturas y clicks por hora local del contacto. Las consultas van parametrizadas por `tenant_id` y se leen por streaming. Agregar un dataset de fixtures chico y determinista en `tests/fixtures/`.

Cubre: FR-48, FR-50 (insumos), NFR-10.

Done when: `uv run pytest services/ml/tests/test_features.py` pasa, validando contra el dataset de fixtures los valores esperados de cada feature calculados a mano para 5 contactos, y que un contacto borrado no aparece.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: SQL y dataframes con reglas claras; el diseño del modelo vive en las tareas siguientes.
- **Dependencies**: F6.3.T1
- **Files**:
  - `services/ml/src/ml/features/`
  - `services/ml/tests/test_features.py`
  - `services/ml/tests/fixtures/`

### F6.3.T3 — Entrenamiento de recomendaciones

Implementar `ml.recs`: co-ocurrencia item-item normalizada (coseno sobre la matriz de interacciones, top 50 vecinos por ítem) para `RELATED` y `CART`; ALS con `implicit` (factores de 64 dimensiones) para `PERSONAL`; más vendidos por categoría en 30 días para `POPULAR` y como fallback de arranque en frío. Evaluación offline con holdout temporal (última semana): precision@10 y recall@10 frente a la línea base de populares. Exportar los artefactos exactamente con el layout de `contracts/dsl/model-artifacts.md` (`item_item.parquet`, `als_factors.npz`, `popular.parquet`, `manifest.json` con métricas).

Cubre: FR-48.

Done when: `uv run pytest services/ml/tests/test_recs.py` pasa verificando que sobre el dataset de fixtures ALS supera a populares en precision@10, que ningún ítem se recomienda a sí mismo en `RELATED`, y que el manifest valida contra el esquema de `model-artifacts.md`.

- **Model**: claude/claude-opus-5
- **Estimate**: 4h
- **Reason**: Diseño y evaluación de modelos de recomendación.
- **Dependencies**: F6.3.T2
- **Files**:
  - `services/ml/src/ml/recs/`
  - `services/ml/tests/test_recs.py`

### F6.3.T4 — Churn y CLV con exportación a ONNX

Implementar `ml.churn` (clasificación LightGBM: sin compra ni engagement en los próximos 90 días, etiqueta construida con fecha de corte) y `ml.clv` (regresión LightGBM del revenue de 365 días). Ambos con split temporal, métricas en el manifest (AUC y logloss para churn; MAE y RMSE para CLV), exportación a `model.onnx` con los nombres de input/output fijados en `model-artifacts.md` y lista ordenada de features en el manifest. Test de paridad: las predicciones de `onnxruntime` y de LightGBM difieren menos de 1e-4 en el dataset de fixtures.

Cubre: FR-50, NFR-7 (modelo servible en Go).

Done when: `uv run pytest services/ml/tests/test_churn_clv.py` pasa con el test de paridad ONNX, AUC > 0.6 en el dataset de fixtures (que trae señal sintética) y el manifest valida contra el esquema.

- **Model**: claude/claude-opus-5
- **Estimate**: 4h
- **Reason**: Construcción de etiquetas sin fuga temporal y exportación ONNX; errores sutiles.
- **Dependencies**: F6.3.T2
- **Files**:
  - `services/ml/src/ml/churn/`
  - `services/ml/src/ml/clv/`
  - `services/ml/tests/test_churn_clv.py`

### F6.3.T5 — Send time optimization y ciclo de vida

Implementar `ml.sto`: por contacto, histograma de 24 horas locales de aperturas y clicks con suavizado bayesiano (prior = distribución del tenant, fuerza configurable, por defecto 10 eventos equivalentes), `best_hour` = argmax y sin historial = mejor hora del tenant. Implementar `ml.lifecycle` con reglas RFM: `new` (primera compra < 30 d), `active`, `at_risk` (recencia > p75 del tenant), `lapsed` (> 180 d) y `churned` (> 365 d o churn > 0.9 cuando exista el modelo). Exportar `sto.parquet` y `lifecycle.parquet` según `model-artifacts.md`.

Cubre: FR-50, FR-51.

Done when: `uv run pytest services/ml/tests/test_sto_lifecycle.py` pasa verificando que un contacto con 20 aperturas a las 9 h tiene `best_hour=9`, que uno sin historial toma la hora del tenant, y la etiqueta de ciclo de vida de 6 contactos de fixture.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Estadística simple con reglas explícitas.
- **Dependencies**: F6.3.T2
- **Files**:
  - `services/ml/src/ml/sto/`
  - `services/ml/src/ml/lifecycle/`
  - `services/ml/tests/test_sto_lifecycle.py`

### F6.3.T6 — Registro, activación y predicciones batch

Implementar `ml.registry` y la CLI `uv run ml train --tenant --kind`, `ml activate --model-id` y `ml rollback --kind`. `train` corre el pipeline del kind, sube los artefactos a `models/<tenant>/<kind>/<version>/`, inserta en `ml.models` con `status=trained` y publica `ml.model.trained`. `activate` marca la versión como `active` (una activa por tenant y kind, en transacción), publica `ml.model.activated` y escribe las predicciones batch en ClickHouse `contact_scores` (churn, CLV, lifecycle, best_hour, `model_version`) para todos los contactos no borrados. `rollback` activa la versión anterior. Los contactos borrados por GDPR se excluyen en cada entrenamiento (NFR-10).

Cubre: FR-50, FR-52, NFR-10, NFR-17.

Done when: `uv run pytest services/ml/tests/test_registry.py` pasa contra Compose, verificando que train → activate → rollback deja exactamente una versión activa, que publica ambos eventos con el envelope C1 y que `contact_scores` tiene una fila por contacto no borrado con la versión activa.

- **Model**: claude/claude-opus-5
- **Estimate**: 4h
- **Reason**: Consistencia transaccional entre Postgres, MinIO, NATS y ClickHouse; la activación afecta lo que se sirve en línea.
- **Dependencies**: F6.3.T3, F6.3.T4, F6.3.T5, F6.1.T4
- **Files**:
  - `services/ml/src/ml/registry/`
  - `services/ml/src/ml/cli.py`
  - `services/ml/tests/test_registry.py`

### F6.3.T7 — API de registro y agenda de reentrenamiento

Exponer con FastAPI las rutas ml de `contracts/openapi/admin-v1/predict.yaml` (listar modelos con métricas, activar, entrenar ahora como job asíncrono), verificando el JWT de usuario contra el JWKS de core y el permiso `predict:admin`. Agregar `ml.scheduler`: un proceso que reentrena cada kind por tenant según cron (por defecto diario 03:00 en la zona del tenant) con lock advisory de Postgres para no duplicar corridas. Ambos procesos se arrancan desde la misma imagen con comandos distintos.

Cubre: FR-52.

Done when: `uv run pytest services/ml/tests/test_api.py` pasa verificando 401 sin token, 403 sin permiso, que activar por API cambia la versión activa, y que dos schedulers simultáneos ejecutan una sola corrida.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2.5h
- **Reason**: API delgada sobre el registro de F6.3.T6.
- **Dependencies**: F6.3.T6
- **Files**:
  - `services/ml/src/ml/api/`
  - `services/ml/src/ml/scheduler.py`
  - `services/ml/tests/test_api.py`

## F6.4 — Package: scorer

### F6.4.T1 — Scaffold del servicio scorer

Crear el módulo Go `services/scorer` con `cmd/scorer/main.go`: servidor gRPC con el `Scorer` generado de F6.1.T1, interceptores de `libs/go/oe` (verificación del token `typ=service` en metadata, propagación de `traceparent`, logs JSON, OTel), health check gRPC, métricas y apagado ordenado. Por ahora los RPC devuelven `Unimplemented`. Agregar el módulo a `go.work` y un Dockerfile distroless con ONNX Runtime.

Cubre: base para NFR-7.

Done when: `go build ./...` y `go test ./...` en `services/scorer` pasan, con un test que llama a `Score` sin token y recibe `Unauthenticated`, y con token recibe `Unimplemented`.

- **Model**: claude/claude-haiku-4-5
- **Estimate**: 2h
- **Reason**: Boilerplate de servicio sobre la lib común.
- **Dependencies**: F6.1.T1
- **Files**:
  - `services/scorer/go.mod`
  - `services/scorer/cmd/scorer/main.go`
  - `services/scorer/internal/server/`
  - `services/scorer/Dockerfile`
  - `go.work`

### F6.4.T2 — Carga de modelos y hot reload

Implementar `internal/models`: al arrancar, carga para cada tenant la versión activa de cada kind (consulta `ml.models` con el rol de solo lectura de scorer) desde MinIO según `model-artifacts.md`. Al recibir `ml.model.activated` (consumidor durable `scorer-models`), descarga la nueva versión, la valida (manifest, sesión ONNX creada, tablas no vacías) y la intercambia de forma atómica (`atomic.Pointer`) sin cortar las peticiones en curso. Si la validación falla, mantiene la versión anterior y registra el error. Estructuras en memoria: sesiones ONNX, mapa item→vecinos, factores ALS, tablas de STO y lifecycle.

Cubre: FR-52 (activar una versión cambia lo que se sirve), NFR-7.

Done when: un test de integración publica `ml.model.activated` apuntando a artefactos de prueba en MinIO y verifica que la versión servida cambia sin errores en 1.000 lecturas concurrentes, y que un artefacto corrupto deja la versión previa.

- **Model**: claude/claude-opus-5
- **Estimate**: 4h
- **Reason**: Concurrencia y swap atómico en caliente; un bug corrompe predicciones en producción.
- **Dependencies**: F6.4.T1
- **Files**:
  - `services/scorer/internal/models/`

### F6.4.T3 — RPC Score

Implementar `Score` en `internal/score`: para churn y CLV arma el vector de features en el orden del manifest desde Redis `feat:<tenant>:<contact>`. Si no hay features en Redis, usa el valor batch de `contact_scores` (lectura ClickHouse con caché LRU de 5 min). `best_hour` y `lifecycle` salen de las tablas del modelo activo. La respuesta incluye `model_versions` por kind. Agregar también el escritor de features: consumidor `scorer-features` de `orders.created` y `messages.opened` que actualiza recencia, frecuencia y monto incrementales en Redis.

Cubre: FR-50, FR-41 (split por modelo, lado servidor), NFR-7.

Done when: `go test ./internal/score/...` pasa con casos de features en Redis, fallback a ClickHouse y contacto desconocido (valores por defecto del tenant), y la predicción ONNX coincide con el valor de referencia del artefacto de prueba con tolerancia 1e-4.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Lógica de lectura con fallbacks bien definidos sobre el loader de F6.4.T2.
- **Dependencies**: F6.4.T2
- **Files**:
  - `services/scorer/internal/score/`

### F6.4.T4 — RPC Recommend

Implementar `Recommend` en `internal/recommend` con las lógicas de F6.1.T1: `PERSONAL` (producto punto entre los factores ALS del contacto y los ítems, top-K con heap; sin factores → `POPULAR`), `RELATED` (vecinos del ítem), `CART` (suma ponderada de vecinos de los ítems del carrito, excluyendo los del carrito), `POPULAR` (por categoría) y `RECENTLY_VIEWED` (últimos `product_view` del contacto en ClickHouse, proyección por `contact_id`). Filtra por disponibilidad, precio y categoría con la caché Redis `cat:*` y excluye siempre el ítem de referencia. Genera un `rec_id` (UUID v7) por respuesta.

Cubre: FR-48, FR-47 (ítems borrados no se recomiendan), NFR-7.

Done when: `go test ./internal/recommend/...` pasa con cada lógica sobre tablas de prueba, verificando que no aparecen ítems no disponibles, borrados ni el ítem de referencia, y que `limit` se respeta.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Algoritmos conocidos sobre estructuras ya cargadas.
- **Dependencies**: F6.4.T2
- **Files**:
  - `services/scorer/internal/recommend/`

### F6.4.T5 — Wiring del scorer y benchmark NFR-7

Conectar `internal/score` e `internal/recommend` al servidor en `cmd/scorer/main.go` y escribir `scripts/bench/scorer/` (ghz o un cliente Go) que mide p99 de `Score` y `Recommend` con un modelo de 50.000 ítems y 100.000 contactos a 500 req/s durante 60 s.

Cubre: NFR-7.

Done when: el bench corre contra el scorer de Compose y reporta p99 < 50 ms para ambos RPC; el resultado queda en `scripts/bench/scorer/RESULTS.md`.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Wiring y medición; sin lógica nueva.
- **Dependencies**: F6.4.T3, F6.4.T4
- **Files**:
  - `services/scorer/cmd/scorer/main.go`
  - `scripts/bench/scorer/`

## F6.5 — Package: personalize y widgets

### F6.5.T1 — Servicio personalize con /p/v1/recs

Crear el módulo Go `services/personalize` (`cmd/personalize/main.go`, Dockerfile, alta en `go.work`) con `GET /p/v1/recs` según `contracts/openapi/catalog.yaml`: autentica por `tenant_key` público (como collector, C10), resuelve `anonymous_id` → `contact_id` con `identity_links` (caché Redis), llama a `scorer.Recommend` por gRPC con token de servicio y devuelve ítems + `rec_id`. CORS restringido a los orígenes del tenant, `Cache-Control: private, max-age=60` y rate limit por `tenant_key`.

Cubre: FR-49 (widget web), NFR-7.

Done when: `go test ./...` en `services/personalize` pasa con un scorer fake: clave inválida → 401, visitante anónimo sin link → recomendaciones `POPULAR`, contacto identificado → la lógica pedida; y un test de CORS rechaza un origen no registrado.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Endpoint público con auth por clave y CORS; patrón ya usado en collector.
- **Dependencies**: F6.1.T1, F6.1.T2, F6.4.T1
- **Files**:
  - `services/personalize/go.mod`
  - `services/personalize/cmd/personalize/main.go`
  - `services/personalize/internal/recs/`
  - `services/personalize/Dockerfile`
  - `go.work`

### F6.5.T2 — Comando recs del web-sdk

Agregar al web-sdk el comando `oe('recs', el, {logic, item_id?, limit, filters, template?})` (C10): pide `/p/v1/recs`, renderiza con un template por defecto accesible (lista de enlaces con imagen, `alt` y precio formateado con `Intl`) o con una función del sitio, registra impresión con `IntersectionObserver` (50% visible) y click, y los envía como `behavior.tracked` kind `custom` (`oe_rec_impression`, `oe_rec_click` con `rec_id`, `item_id` y `widget` = id del elemento) por el batching existente. El código de recs se carga como chunk diferido para que `sdk.js` siga < 10 KB gz. Registrar el comando en `src/index.ts`.

Cubre: FR-49, FR-53.

Done when: los tests de navegador del web-sdk pasan, verificando render, una impresión por elemento visible, un click por interacción y el tamaño gzip de `sdk.js` < 10 KB en el check de build.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Feature de front con reglas claras sobre el SDK existente.
- **Dependencies**: F6.1.T2
- **Files**:
  - `packages/web-sdk/src/recs/`
  - `packages/web-sdk/src/index.ts`

### F6.5.T3 — Revenue atribuido a widgets

Agregar la migración `0602_rec_widget_revenue.sql`: vista materializada que une `oe_rec_click` con órdenes del mismo contacto en los 7 días siguientes que contengan el `item_id` clickeado, y agrega por `(tenant_id, widget, day)`: impresiones, clicks y revenue. Exponer `GET /admin/v1/predict/widgets/stats` en personalize (JWT de usuario, permiso `predict:view`) según `admin-v1/predict.yaml`, registrando la ruta en `cmd/personalize/main.go`. Es una atribución propia del widget: la atribución general por campaña llega en F8.

Cubre: FR-53.

Done when: un test de integración inserta impresiones, un click y una orden a los 3 días (suma) y otra a los 8 días (no suma) y verifica la respuesta del endpoint.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: SQL de ClickHouse + endpoint de lectura.
- **Dependencies**: F6.5.T1
- **Files**:
  - `deploy/clickhouse/migrations/0602_rec_widget_revenue.sql`
  - `services/personalize/internal/stats/`
  - `services/personalize/cmd/personalize/main.go`

### F6.5.T4 — Widgets de recomendaciones en demo-shop

Agregar en demo-shop un componente de recomendaciones que usa `oe('recs', ...)`: "Relacionados" en la página de producto (`RELATED`), "Completá tu compra" en el carrito (`CART`) y "Para vos" en la home (`PERSONAL`), con estados de carga y vacío.

Cubre: FR-49 (acceptance en el sitio demo), FR-48.

Done when: el test Playwright de demo-shop abre un producto y ve 4 recomendaciones que no incluyen el producto actual, y el carrito muestra recomendaciones que no están en el carrito (contra el stack de Compose con modelos semilla).

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Integración de UI simple.
- **Dependencies**: F6.5.T2
- **Files**:
  - `apps/demo-shop/src/components/recs/`
  - `apps/demo-shop/src/app/page.tsx`
  - `apps/demo-shop/src/app/products/[id]/page.tsx`
  - `apps/demo-shop/src/app/cart/page.tsx`
  - `apps/demo-shop/tests/recs.spec.ts`

## F6.6 — Package: integración predict

### F6.6.T1 — Recomendaciones en el render del dispatcher

En `services/dispatcher/internal/render`, cuando la `content_version` trae `recs_slots` (F6.1.T5), resolver cada slot con `scorer.Recommend` (contacto del mensaje, ítem o carrito del contexto del evento si la lógica lo requiere) antes de renderizar, e inyectar `recs.<name>` en el contexto Liquid (C8). Los enlaces de productos pasan por la reescritura de tracking existente (C9) con `rec_id` en la URL. Timeout de 100 ms por slot: si vence, el slot queda vacío y renderiza el fallback. Aplica también a `POST /internal/v1/render` para las vistas previas.

Cubre: FR-49 (email), FR-53 (clicks con rec_id).

Done when: `go test ./internal/render/...` pasa con los fixtures `contracts/dsl/fixtures/render/recs-*` y con un scorer fake lento que dispara el fallback.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Extensión del pipeline de render con contratos ya fijados.
- **Dependencies**: F6.1.T1, F6.1.T5
- **Files**:
  - `services/dispatcher/internal/render/recs.go`
  - `services/dispatcher/internal/render/recs_test.go`
  - `services/dispatcher/internal/render/context.go`

### F6.6.T2 — Send time optimization en campañas

Crear el módulo `sto` en campaigns: si la agenda de la campaña trae `sto: {window_hours: 24}`, al lanzar se lee `best_hour` por lotes desde ClickHouse `contact_scores` (no por gRPC, para no hacer 1 M de llamadas) y cada `messages.send.requested` sale con `send_at` = próxima ocurrencia de esa hora en la zona del contacto dentro de la ventana. Sin score, se usa la hora de lanzamiento. Enganchar el módulo en el pipeline de lanzamiento de F4.5 (`src/modules/launch/`). El registro del módulo en `app.module.ts` lo hace F6.7.T1.

Cubre: FR-51.

Done when: los tests del módulo verifican con 3 contactos en zonas y best_hour distintas los `send_at` esperados, y que el contacto sin score sale inmediato.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Cálculo de agenda con zonas horarias sobre el lanzamiento existente.
- **Dependencies**: F6.2.T2
- **Files**:
  - `services/campaigns/src/modules/sto/`
  - `services/campaigns/src/modules/launch/`

### F6.6.T3 — split_model y envío con STO en engine

En engine: activity `ScoreContact` (`internal/activities/model.go`) que llama a `scorer.Score`; nodo `split_model` (C7) que manda al contacto a la rama `above` o `below` según el umbral; y soporte de `send.sto=true`, que antes de publicar hace `workflow.Sleep` hasta el próximo `best_hour` del contacto (máximo 24 h). Proteger el cambio del intérprete con `workflow.GetVersion` y agregar un test de replay con un historial grabado antes del cambio (riesgo de versionado del arch).

Cubre: FR-41 (split por modelo), FR-51 (programas), NFR-11.

Done when: `go test ./...` en engine pasa con tests del entorno de pruebas de Temporal para ambas ramas del split, la espera de STO con reloj simulado y el replay de un historial pre-F6 sin errores de no-determinismo.

- **Model**: claude/claude-opus-5
- **Estimate**: 4h
- **Reason**: Cambio en un workflow durable en producción; el no-determinismo es fácil de introducir.
- **Dependencies**: F6.1.T1
- **Files**:
  - `services/engine/internal/activities/model.go`
  - `services/engine/internal/workflow/split_model.go`
  - `services/engine/internal/workflow/sto.go`
  - `services/engine/internal/workflow/nodes.go`
  - `services/engine/internal/replay/testdata/pre-f6/`
  - `services/engine/cmd/engine/main.go`

### F6.6.T4 — Kind score en el compilador de segmentos

Implementar el criterio `score` (F6.1.T3) en el compilador de F3.2: subconsulta `contact_id IN (SELECT contact_id FROM contact_scores FINAL WHERE tenant_id = ? AND <col> <cmp> ?)`, con parámetros ligados (nunca interpolados) y mapeo de `lifecycle` a `IN`. Registrar el kind en el dispatch del compilador.

Cubre: FR-50 (segmentable).

Done when: los tests golden del compilador pasan con los fixtures `score-*` de F6.1.T3 y el test de exactitud sobre el dataset chico devuelve los contactos esperados para `churn >= 0.7` combinado con compra en 30 días.

- **Model**: claude/claude-opus-5
- **Estimate**: 2h
- **Reason**: Compilador DSL→SQL; un error de SQL o de inyección afecta a todos los segmentos.
- **Dependencies**: F6.1.T3, F6.2.T2
- **Files**:
  - `services/segments/internal/compiler/score.go`
  - `services/segments/internal/compiler/score_test.go`
  - `services/segments/internal/compiler/compile.go`
  - `services/segments/internal/compiler/testdata/score/`

### F6.6.T5 — Bloque de productos en content

Agregar el tipo de bloque `products` al árbol de plantillas de content: configuración (`logic`, filtros, `limit` 1–12, columnas 1–4, fallback) → MJML de grilla con Liquid `{% for p in recs.<slot> %}` según F6.1.T5, validación de sintaxis y del nombre de slot, y persistencia de `recs_slots` en `content_versions` (campo nuevo en el esquema Prisma de content, con su migración). Expuesto en `GET /internal/v1/content-versions/{id}`.

Cubre: FR-49.

Done when: los tests de content compilan una plantilla con dos bloques de productos, el MJML compila sin errores, la versión guarda dos `recs_slots` con nombres únicos y la API interna los devuelve.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Nuevo bloque sobre el compilador MJML existente de F4.2.
- **Dependencies**: F6.1.T5
- **Files**:
  - `services/content/src/modules/blocks/products/`
  - `services/content/prisma/schema/content.prisma`
  - `services/content/prisma/migrations/`
  - `services/content/src/modules/versions/`

## F6.7 — Package: admin-web predict y e2e

### F6.7.T1 — Cierre de F6: wiring y e2e de Predict

Registrar los módulos nuevos (`catalog` en core, `sto` en campaigns) en sus `app.module.ts`. Crear `deploy/compose/services/{ml,scorer,personalize}.yml` (ml-api, ml-scheduler, scorer, personalize, con límites de memoria y perfil `ai`) e incluirlos en `docker-compose.yml`. Agregar las rutas Traefik de `/api/v3/catalog`, `/api/v3/recommendations`, `/p/`, `/admin/v1/catalog`, `/admin/v1/predict/models|train` (ml) y `/admin/v1/predict/widgets` (personalize). Extender el seed con un catálogo de 5.000 productos y un entrenamiento inicial. Escribir `tests/e2e/predict/`: (1) campaña con bloque de productos personal filtrado por categoría enviada a Mailpit con solo productos de esa categoría y disponibles (FR-49); (2) borrado por API desaparece de `/p/v1/recs` en < 5 min (FR-47); (3) widget en demo-shop, click y compra suman revenue en widget stats (FR-53); (4) activar la versión anterior cambia `model_version` en `Score` (FR-52); (5) segmento `churn >= 0.7` cuenta lo mismo que la consulta directa a `contact_scores` (FR-50); (6) campaña con STO agenda envíos distintos por contacto (FR-51).

Cubre: FR-47 a FR-53 (aceptación), NFR-13.

Done when: `docker compose --profile core --profile data --profile ai up` levanta todo sano y `pnpm test:e2e --filter predict` pasa los seis escenarios.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 6h
- **Reason**: Integración amplia pero mecánica; los escenarios ya están definidos.
- **Dependencies**: F6.2.T1, F6.2.T3, F6.3.T7, F6.4.T5, F6.5.T3, F6.5.T4, F6.6.T1, F6.6.T2, F6.6.T3, F6.6.T4, F6.6.T5, F6.7.T2, F6.7.T3, F6.7.T4
- **Files**:
  - `services/core/src/app.module.ts`
  - `services/campaigns/src/app.module.ts`
  - `deploy/compose/services/ml.yml`
  - `deploy/compose/services/scorer.yml`
  - `deploy/compose/services/personalize.yml`
  - `deploy/compose/docker-compose.yml`
  - `deploy/traefik/dynamic/predict.yml`
  - `scripts/seed/predict/`
  - `tests/e2e/predict/`

### F6.7.T2 — admin-web: catálogo y feed

Pantallas en `(console)/predict/catalog/`: listado paginado de productos con búsqueda y filtro por disponibilidad y categoría, detalle, y configuración del feed (URL, cron, mapeo de columnas, último job con errores). Crear `src/nav/predict.ts` con las tres entradas de Predict (Catálogo, Modelos, Widgets) y los mensajes es/pt/en de este paquete en `messages/*/predict-catalog.json`. Usa el cliente tipado de `admin-v1/predict.yaml`.

Cubre: FR-47, NFR-15, NFR-16.

Done when: el test de componentes y un test Playwright contra mocks de la API recorren listado → detalle → guardar feed, y axe no reporta violaciones AA.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Pantallas CRUD con los patrones de la consola.
- **Dependencies**: F6.1.T4
- **Files**:
  - `apps/admin-web/src/app/[locale]/(console)/predict/catalog/`
  - `apps/admin-web/src/nav/predict.ts`
  - `apps/admin-web/messages/es/predict-catalog.json`
  - `apps/admin-web/messages/pt/predict-catalog.json`
  - `apps/admin-web/messages/en/predict-catalog.json`

### F6.7.T3 — admin-web: registro de modelos y scores en la ficha

Pantalla `(console)/predict/models/`: por kind, versiones con fecha, métricas del manifest, estado, botón "Activar" con confirmación y "Entrenar ahora" (job con progreso). Componente `contact-scores` en la ficha del contacto (F1.5) con churn (barra y umbral), CLV formateado en la moneda del tenant, etapa de ciclo de vida y mejor horario en la zona del contacto. Mensajes en `messages/*/predict-models.json`.

Cubre: FR-50, FR-52, NFR-15, NFR-16.

Done when: un test Playwright contra mocks activa una versión anterior y ve el cambio de estado, y la ficha del contacto muestra los cuatro valores; axe sin violaciones AA.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: UI de datos sobre contratos existentes.
- **Dependencies**: F6.1.T4
- **Files**:
  - `apps/admin-web/src/app/[locale]/(console)/predict/models/`
  - `apps/admin-web/src/components/contact-scores/`
  - `apps/admin-web/src/app/[locale]/(console)/contacts/[id]/page.tsx`
  - `apps/admin-web/messages/es/predict-models.json`
  - `apps/admin-web/messages/pt/predict-models.json`
  - `apps/admin-web/messages/en/predict-models.json`

### F6.7.T4 — admin-web: bloque de productos, criterio score y stats de widgets

Agregar al editor de email (F4.6) el bloque "Productos" con panel de configuración (lógica, filtros, límite, columnas, fallback) y vista previa vía `render` del dispatcher. Agregar al builder de segmentos (F3.4) el criterio "Predicción" (churn, CLV, ciclo de vida, mejor horario) según F6.1.T3. Pantalla `(console)/predict/widgets/` con impresiones, clicks, CTR y revenue por widget en un rango de fechas. Registrar el bloque y el criterio en los índices del editor y del builder. Mensajes en `messages/*/predict-widgets.json`.

Cubre: FR-49, FR-50, FR-53, NFR-15.

Done when: los tests de componentes del editor y del builder pasan con el bloque y el criterio nuevos (la definición generada valida contra `segment.schema.json`), y un test Playwright contra mocks muestra la tabla de widgets.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Extensiones de UI sobre editor y builder existentes.
- **Dependencies**: F6.1.T3, F6.1.T4, F6.1.T5
- **Files**:
  - `apps/admin-web/src/components/email-editor/blocks/products/`
  - `apps/admin-web/src/components/email-editor/blocks/index.ts`
  - `apps/admin-web/src/components/segment-builder/criteria/score/`
  - `apps/admin-web/src/components/segment-builder/criteria/index.ts`
  - `apps/admin-web/src/app/[locale]/(console)/predict/widgets/`
  - `apps/admin-web/messages/es/predict-widgets.json`
  - `apps/admin-web/messages/pt/predict-widgets.json`
  - `apps/admin-web/messages/en/predict-widgets.json`
