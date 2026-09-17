# Rx — Emarsys (SAP Engagement Cloud)

> Radiografía para decidir alcance, arquitectura y stack de **open-emarsys**.
> Fecha: 2026-09-17. Leyenda: ✅ verificado en fuente pública 2026 · 📚 conocimiento general del producto (validar contra docs antes de copiarlo tal cual).

---

## 1. Qué es hoy

- ✅ Desde **febrero 2026** Emarsys se llama **SAP Engagement Cloud**, con dos ediciones:
  - **Emarsys Edition**: el producto de siempre, sin cambios.
  - **Enterprise Edition**: suma Joule AI, señales de ERP en tiempo real y orquestación entre las nubes de SAP.
- 📚 Historia: fundada en 2000 en Viena/Budapest. Compró **Scarab Research** en 2013 (motor de recomendaciones, hoy *Predict*). SAP la compró en 2020.
- Categoría: **plataforma de customer engagement omnicanal**, con foco en retail y e-commerce B2C. Es más un **marketing automation con CDP liviano** que un CRM de ventas: no tiene pipeline de deals ni un inbox de soporte.

> ⚠️ **Implicancia para el proyecto:** "CRM tipo Emarsys" significa contactos + datos de comportamiento + segmentación + canales + automatización. No es un Salesforce/HubSpot de ventas. Conviene decidirlo explícitamente.

---

## 2. Mapa de módulos

| Capa | Módulo | Qué hace | Dificultad de clonar |
|---|---|---|---|
| **Datos** | Contact Database | Contactos con campos de sistema y campos custom identificados por **field ID** numérico | Media |
| | Relational Data | Tablas propias del cliente, unidas a contactos (ej. mascotas, autos, pólizas) | Media-alta |
| | Sales Data / Smart Insight | Órdenes importadas (CSV/SFTP/API), análisis **RFM**, CLV, ciclo de vida del cliente | Alta |
| | Product Catalog | Feed de productos (CSV/stream API ✅ Q2 2026) que usan Predict y los bloques de email | Media |
| | Web Extend (tracking) | Script JS: vistas de producto, carrito, compras, búsquedas; identifica al visitante | Media |
| | Open Data | Export de todos los eventos a un data warehouse (BigQuery 📚) para BI | Media |
| **Audiencia** | Segments | Builder por criterios: campos, comportamiento (abrió/clickeó/compró), combinados (AND/OR/NOT) | **Alta** (núcleo técnico) |
| | Contact Lists | Listas estáticas, por import o por API | Baja |
| **Canales** | Email | Editor de bloques (VCE), personalización, envío masivo, tracking, bounces, bajas | **Alta** (entregabilidad) |
| | SMS | Envío vía proveedores, códigos cortos/largos, opt-in propio | Media |
| | Mobile Engage | Push, in-app, inbox (con SDK iOS/Android) | Alta |
| | Web Channel | Overlays/banners en el sitio, personalizados por segmento | Media |
| | Mobile Wallet | Pases de Apple/Google Wallet | Media |
| | Digital Ads | Sincronizar audiencias con Meta/Google | Media (depende de APIs externas) |
| **Orquestación** | Automation Center | Programas visuales: trigger → espera → condición/split → acción por canal | **Alta** (motor durable) |
| | Interactions 📚 | Programas por eventos en tiempo real, entre canales | Alta |
| **Inteligencia** | Predict | Recomendaciones de producto (personal, related, cart, popular) | Alta |
| | AI Marketing | Send time optimization, churn, CLV predictivo, incentivos | Alta |
| | Gen AI ✅ | Content Composer (texto + imagen en email), descripción de segmentos con IA, Joule (lenguaje natural) | Media (vía LLM) |
| **Fidelización** | Loyalty | Niveles, puntos, recompensas, wallet de loyalty | Media-alta |
| **Medición** | Reporting | Métricas por campaña, revenue attribution, reportes por canal | Media |
| **Plataforma** | Multi-tenant | "Customer account" + business units como tenants separados ✅ | Media |
| | Usuarios/roles | Permisos por usuario/área | Baja-media |
| | API REST | v2 con WSSE (✅ **deprecada, sunset fin de 2026**) → v3 con **OAuth 2.0 + OIDC** (JWT) ✅ | Media |
| | Integraciones | Shopify, Magento, SAP Commerce, Salesforce, CDP, etc. | Variable |

---

## 3. Modelo de datos (conceptos clave)

- 📚 **Field IDs**: todo campo de contacto es un número. Los de sistema son fijos: `1` nombre, `2` apellido, `3` email, `31` opt-in, etc. Los custom arrancan desde un ID alto. La API usa los IDs, no los nombres:
  ```json
  { "key_id": "3", "contacts": [{ "3": "ana@x.com", "1": "Ana", "31": 1 }] }
  ```
- 📚 **key_id**: cada llamada elige qué campo identifica al contacto (email, external_id o cualquier campo único).
- 📚 **Opt-in**: `1` = sí, `2` = no, vacío = desconocido. Cada canal tiene su propio consentimiento (email, SMS y push por separado).
- 📚 **External Events**: eventos con nombre, definidos por el cliente (`order_shipped`), que disparan emails o programas con un payload para personalizar.
- 📚 **Tipos de campo**: texto, número, fecha, single choice y multi choice. Las opciones de choice también tienen ID.
- **Datos de comportamiento**: envíos, aperturas, clicks, bounces, bajas, vistas web, compras. Es el volumen dominante: **órdenes de magnitud más que los contactos**.

## 4. Superficie de API (a replicar)

📚 Grupos principales de la Core API (confirmar paths contra dev.emarsys.com):

| Grupo | Ejemplos |
|---|---|
| Contacts | crear/actualizar/borrar en batch (hasta ~1000 por llamada), `getdata`, búsqueda |
| Fields | listar, crear, choices |
| Contact lists | crear, agregar/quitar contactos |
| Segments | listar, contar, correr segmento |
| Email campaigns | crear, lanzar, test, preview, tracking de respuestas |
| External events | listar, crear, **trigger** (con payload) |
| Automation | disparar programas, estado |
| Exports | export async de contactos/respuestas → poll + descarga |
| Settings | idiomas, senders, dominios |

Patrones: **operaciones batch**, **jobs asíncronos** con `job_id` + polling, respuesta envelope `{ replyCode, replyText, data }` 📚, **rate limits** por endpoint.

---

## 5. Flujo end-to-end (lo que hay que hacer funcionar)

```
[Sitio/App] --Web Extend/SDK--> Ingesta de eventos --+
[ERP/Shop]  --API/CSV/SFTP-->   Contactos/Órdenes ---+--> Almacén de comportamiento
                                                      |
                              Segmentación <----------+
                                   |
                     Automation Center (programas)
                                   |
                 Canales: Email | SMS | Push | Web | Wallet | Ads
                                   |
      Tracking (pixel de apertura, redirect de click, webhooks de bounce/entrega)
                                   |
             Reporting + Revenue attribution (click → compra en N días)
```

---

## 6. Los problemas técnicos duros (lo más valioso para estudiar)

1. **Campos custom dinámicos**: EAV vs. `JSONB` vs. columnas reales creadas en runtime. Esto define si la segmentación es rápida o imposible.
2. **Segmentación a escala**: combinar criterios de perfil y de comportamiento sobre millones de filas de eventos, en segundos. Normalmente sale de un **almacén columnar** (ClickHouse, BigQuery), no de Postgres.
3. **Motor de automatización durable**: esperas de días o semanas, reintentos, idempotencia, versionado del programa mientras hay contactos adentro, sin perder estado si reinicia un worker.
4. **Envío de email**: throughput (miles/seg), IP pools, warm-up, SPF/DKIM/DMARC, procesamiento de bounces/FBL, List-Unsubscribe one-click (requisito Gmail/Yahoo), supresión.
5. **Tracking de alto volumen**: el pixel y el redirect tienen que responder en ms y escribir async.
6. **Ingesta de eventos**: picos (Black Friday), deduplicación, orden de llegada, identificación anónimo → conocido.
7. **Recomendaciones**: co-ocurrencia/collaborative filtering sobre catálogo + comportamiento, servidas en tiempo real.
8. **Multi-tenancy**: aislar datos (RLS, schema por tenant o tenant_id), límites por tenant, *noisy neighbours*.
9. **GDPR/consentimiento**: borrado real, export de datos del contacto, auditoría de opt-in.

---

## 7. Stack: tu stack vs. lo que pide el problema

| Pieza | Tu stack | Veredicto | Tensión / alternativa a discutir |
|---|---|---|---|
| API + dominio | NestJS 10 | ✅ Encaja | Considerar NestJS 11 si arrancamos de cero |
| ORM | Prisma | ⚠️ Parcial | Sirve para el CRUD, **no para campos dinámicos ni para el query builder de segmentos**. Mezclar con SQL crudo o Kysely |
| DB transaccional | PostgreSQL | ✅ Encaja | Campos custom en `JSONB` + índices GIN; RLS para multi-tenant |
| Eventos / analítica | — | ❌ Falta | **ClickHouse** para eventos, segmentación por comportamiento y reporting. Postgres solo aguanta en escala de estudio |
| Colas | Redis + BullMQ | ✅ Envíos, imports, exports | Para el Automation Center: BullMQ (delayed jobs + estado en Postgres) **o Temporal**. Punto clave a decidir |
| Frontend admin | Next.js 15 + shadcn + next-intl | ✅ Encaja | Builder de programas: **React Flow**. Builder de segmentos: componente propio |
| Editor de email | — | ❌ Falta | **MJML** para render + editor de bloques (GrapesJS/Unlayer o propio) |
| MTA (envío real) | — | ❌ Falta | Local: **Mailpit**. Real: SES/Postmark, o **Postal/Haraka** si querés estudiar entregabilidad |
| SMS / Push | — | — | Twilio (o mock) / FCM + APNs |
| Web Extend | — | — | Script TS vanilla bundleado (esbuild), endpoint de collect liviano |
| Predict / IA | Python 3.11 + LangChain | ✅ Encaja | Recos: `implicit`/ALS o co-ocurrencia en SQL. Gen AI: tu router LLM multi-provider |
| Assets | MinIO | ✅ Encaja | Imágenes de emails, archivos de import/export |
| Auth API | — | — | OAuth 2.0 client credentials (como la v3). **No clonar WSSE**: muere a fin de 2026 |
| **Hot path (neurálgico)** | **Go** | ✅ Encaja | Ver §7.1: ingesta, tracking, envío, ejecutor de programas y scoring IA en tiempo real |
| Infra | Docker Compose + Hetzner | ✅ Encaja | Monorepo con pnpm workspaces + Turborepo + `go.work` para los servicios Go |

### 7.1 Go en la parte neurálgica + IA

Regla de corte: **NestJS = control plane** (configuración, CRUD, UI, API de gestión). **Go = data plane** (todo lo que corre por evento o por contacto a alto volumen). **Python = entrenamiento** (offline).

| Servicio Go | Qué hace | IA que se le suma |
|---|---|---|
| `collector` | Ingesta de eventos (Web Extend, SDK, External Events API) → cola/ClickHouse | Detección de anomalías y bots; identity resolution (anónimo → contacto) |
| `tracker` | Pixel de apertura y redirect de click, en ms | Filtrar aperturas de máquina (Apple MPP, scanners de seguridad) |
| `dispatcher` | Envío por canal (email/SMS/push), throttling por IP/dominio/tenant | **Send time optimization** por contacto; elección de canal |
| `engine` | Ejecuta los programas del Automation Center: evalúa triggers, esperas y splits | **Next best action**: splits decididos por modelo en vez de por regla |
| `recs` | Sirve recomendaciones en tiempo real (email al abrir, web) | Modelos de Predict (co-ocurrencia/ALS/embeddings con pgvector) |
| `scorer` | Scoring en línea: churn, CLV, propensión de compra | Modelos entrenados en Python → exportados a **ONNX** → inferencia en Go |

Dos tipos de IA, dos caminos:
- **Predictiva (ML clásico)**: se entrena en Python y se sirve en Go (ONNX Runtime o modelos simples cargados en memoria). Latencia de ms, costo casi nulo.
- **Generativa (LLM)**: contenido, asunto del email, segmentos por lenguaje natural, agente tipo Joule. No va en el hot path por latencia y costo: vive en el control plane (tu router LLM multi-provider) o en un worker Go asíncrono con el SDK oficial.

---

## 8. Fases tentativas (borrador para discutir)

| Fase | Contenido | Resultado demostrable |
|---|---|---|
| **F0 Fundaciones** | Monorepo, Compose, tenants, usuarios/roles, auth OAuth para la API | Login + tenant + API key |
| **F1 Contactos** | Campos con field IDs, CRUD batch, import/export CSV, consentimiento | API compatible en forma con Emarsys |
| **F2 Eventos + tracking** | `collector` + `tracker` en Go, External Events, Web Extend, ClickHouse | Ver comportamiento de un contacto |
| **F3 Segmentos** | Builder perfil + comportamiento, listas, conteos | "Compró en 30 días y no abrió emails" |
| **F4 Email** | Editor MJML, personalización, `dispatcher` en Go, pixel/click, bounces, bajas | Campaña real enviada y medida |
| **F5 Automation Center** | Editor visual (Next.js) + `engine` en Go: triggers, esperas, splits | Carrito abandonado funcionando |
| **F6 Catálogo + Predict** | Product catalog, entrenamiento Python, `recs` + `scorer` en Go (ONNX), STO | Bloque "te puede interesar" |
| **F7 Canales extra** | SMS, push, web channel, wallet | Programa omnicanal |
| **F8 Reporting** | Dashboards, revenue attribution | Revenue por campaña |
| **F9 Loyalty** | Niveles, puntos, recompensas | Programa de puntos |
| **F10 IA generativa** | Content composer, segmentos por lenguaje natural | Crear campaña con prompt |

---

## 9. Decisiones abiertas

1. **¿Compatibilidad de API con Emarsys?** Replicar forma (field IDs, envelopes) para poder usar sus docs como spec, o diseñar una API limpia inspirada.
2. **¿ClickHouse desde F2** o Postgres puro hasta que duela?
3. **¿Automation Center en BullMQ o Temporal?**
4. **¿Envío real de email?** Mailpit + SES alcanza para estudiar, Postal/Haraka si el objetivo es aprender entregabilidad.
5. **¿Multi-tenant de verdad desde F0** (RLS) o `tenant_id` simple?
6. **¿Mobile Engage con SDK Flutter?** Encaja con tu stack, pero es una fase grande.
7. **¿Cómo hablan NestJS y Go?** Cola compartida (NATS/Redis Streams) vs gRPC. BullMQ es solo Node: si Go consume trabajos, hace falta un broker neutral.
8. **¿El motor de programas (`engine`) es Go puro** con estado en Postgres, o Temporal (tiene SDK Go de primera)?
9. **¿Escala objetivo del estudio?** (ej. 1M contactos, 100M eventos). Define si ClickHouse y Temporal se justifican.

---

### Fuentes
- [SAP Emarsys renombrado a SAP Engagement Cloud (Spadoom)](https://www.spadoom.com/en/blog/sap-emarsys-now-sap-engagement-cloud/)
- [Emarsys Edition vs Enterprise Edition (Spadoom)](https://www.spadoom.com/en/blog/sap-engagement-cloud-emarsys-vs-enterprise-edition/)
- [SAP Engagement Cloud Q2 2026 Release](https://emarsys.com/learn/blog/sap-engagement-cloud-q2-2026-release/)
- [SAP Engagement Cloud Q3 2026 Release](https://emarsys.com/learn/blog/sap-engagement-cloud-q3-2026-release/)
- [Authentication in v3 API (Emarsys Dev)](https://dev.emarsys.com/docs/emarsys-core-api-guides/b3c3a1eba8515-authentication-in-v3-api)
- [Perfil de la API de Emarsys (API Evangelist)](https://github.com/api-evangelist/emarsys)
- [Google Cloud multi-agent (press release)](https://emarsys.com/press-release/sap-engagement-cloud-expands-ai-innovation-with-google-cloud-to-enable-multi-agent-marketing-execution/)
- [Scarab Research (Wikipedia)](https://en.wikipedia.org/wiki/Scarab_Research)
