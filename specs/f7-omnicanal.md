---
type: spec
project_id: open-emarsys
phase: 7
version: 0.1
depends_on:
  - docs/arch/001-open-emarsys.md
  - docs/prd/001-open-emarsys.md
consumed_by:
  - orch-atomizer
generated_by: orch-spec
generated_at: 2026-09-17
title: Omnicanal
---

# F7 — Omnicanal

Milestone M7 del PRD: SMS, push y bandeja en apps Flutter y navegadores, piezas web, pases de wallet y audiencias de Ads (FR-54 a FR-59). Todo adaptador externo (Twilio, FCM, APNs, Apple/Google Wallet, Meta, Google Ads) tiene una implementación `fake` por defecto (riesgo del arch, PRD Q2), y los criterios de aceptación corren contra ella. Las tareas de contratos dependen del cierre de F6 (F6.7.T1).

## F7.1 — Package: contracts canales

### F7.1.T1 — API móvil: dispositivos, bandeja, in-app y autenticación del SDK

Escribir `contracts/openapi/mobile.yaml` para el SDK Flutter y Web Push. La auth del SDK usa `app_key` público por app, registrada por tenant, más `anonymous_id` o identificación del contacto con la misma semántica que C10. Rutas (dueño core): `POST /api/v3/mobile/devices` (platform `android|ios|web`, token, app_id, locale, timezone), `DELETE /api/v3/mobile/devices/{id}`, `POST /api/v3/mobile/identify`, `GET /api/v3/mobile/inbox`, `POST /api/v3/mobile/inbox/{id}/read`, `GET /api/v3/mobile/inapp` (mensajes in-app pendientes). Los eventos de la app van por `/c/v1/collect` (C10). Documentar el payload de push (`title, body, image, deep_link, tracking_token`) y que la apertura se reporta llamando `GET /t/o/{token}` (C9). En `contracts/openapi/internal/core-mobile.yaml` fijar los internos (C4) que usa dispatcher: `POST /internal/v1/devices/lookup` (`{tenant_id, contact_ids[], platforms[]}` → tokens activos), `POST /internal/v1/inbox` (crear mensaje de bandeja o in-app) y `POST /internal/v1/devices/invalidate`.

Cubre: FR-55, FR-56 (contrato), NFR-9.

Done when: el linter OpenAPI de CI pasa en ambos archivos y `packages/ts-contracts` regenera sin errores.

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Diseño de autenticación de un SDK público y contratos que comparten Flutter, web-sdk, core y dispatcher.
- **Dependencies**: F6.7.T1
- **Files**:
  - `contracts/openapi/mobile.yaml`
  - `contracts/openapi/internal/core-mobile.yaml`

### F7.1.T2 — Contratos de canales SMS y push: admin, API pública y adaptadores

Escribir `contracts/openapi/admin-v1/channels.yaml` (C3): configuración de canal por tenant (remitentes SMS de Twilio, credenciales de push por app: cuenta de servicio de FCM, llave `.p8` de APNs con team/key id, par VAPID), campañas SMS y push (mismo modelo que las campañas de email de F4 con `channel`) y conteo de segmentos SMS. Extender `contracts/openapi/public-v3.yaml` con `POST /api/v3/sms` y `POST /api/v3/push` (C2, dueño campaigns). Extender `contracts/events/messages.send.requested.schema.json` para que `channel` admita `sms|push|inbox|inapp` con `data` específico por canal. Documentar en `contracts/dsl/channel-adapters.md` la interfaz Go `Channel` del dispatcher (`Send(ctx, Message) (ProviderResult, error)` con errores tipados `Permanent`, `Transient` e `InvalidRecipient`), los webhooks entrantes de proveedores (`/t/wh/twilio`, estados de entrega) y las palabras clave de baja SMS (`STOP`, `PARAR`, `SAIR`, `CANCELAR`, `BAJA`; alta: `START`, `ALTA`).

Cubre: FR-54, FR-55 (contrato).

Done when: el linter OpenAPI y la validación de eventos de CI pasan, y los ejemplos de `messages.send.requested` de F4 siguen validando junto con uno nuevo por canal.

- **Model**: claude/claude-opus-5
- **Estimate**: 3h
- **Reason**: Cambia un contrato central del bus y define la interfaz de adaptadores que usan varias tareas en paralelo.
- **Dependencies**: F6.7.T1
- **Files**:
  - `contracts/openapi/admin-v1/channels.yaml`
  - `contracts/openapi/public-v3.yaml`
  - `contracts/events/messages.send.requested.schema.json`
  - `contracts/events/examples/messages.send.requested.sms.json`
  - `contracts/events/examples/messages.send.requested.push.json`
  - `contracts/dsl/channel-adapters.md`

### F7.1.T3 — Esquema de piezas web y endpoint /p/v1/pieces

Escribir `contracts/dsl/web-piece.schema.json`: tipo (`overlay|banner|bar`), posición, contenido (árbol de bloques de content compilado a HTML), reglas de disparo (`delay_seconds`, `scroll_percent`, `exit_intent`, `page_url_matches`), audiencia (`segment_id` opcional; sin segmento = todos), frecuencia por visitante (`once|session|every_n_days`), vigencia y prioridad. Escribir `contracts/openapi/pieces.yaml` con `GET /p/v1/pieces?tenant_key&anonymous_id&url` → piezas elegibles con HTML y reglas, y el endpoint admin CRUD `/admin/v1/web-pieces` (dueño content). Impresiones, cierres y clicks van por `/c/v1/collect` como `custom` (`oe_piece_impression|oe_piece_close|oe_piece_click`).

Cubre: FR-57 (contrato).

Done when: los fixtures válidos e inválidos de piezas en `contracts/dsl/fixtures/web-pieces/` validan como corresponde en CI y el linter OpenAPI pasa.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Esquema acotado siguiendo patrones de C6/C10.
- **Dependencies**: F6.7.T1
- **Files**:
  - `contracts/dsl/web-piece.schema.json`
  - `contracts/dsl/fixtures/web-pieces/`
  - `contracts/openapi/pieces.yaml`

### F7.1.T4 — Contrato de wallet

Escribir `contracts/openapi/admin-v1/wallet.yaml` (dueño content): plantillas de pase (`coupon|loyalty_card`) con campos, colores, logo y mapeo de campos a variables de personalización (C8); `POST /admin/v1/wallet/templates/{id}/preview`; y el endpoint público firmado `GET /wallet/v1/passes/{token}` que entrega el `.pkpass` o redirige al link "Save to Google Wallet". Documentar en `contracts/dsl/wallet.md` el Apple PassKit Web Service (`/wallet/v1/apple/v1/devices/...`, `/passes/{passTypeId}/{serial}`), el token del link (mismo esquema HMAC que C9, kind `w`) y el interno `POST /internal/v1/wallet/passes/update` (`{tenant_id, contact_id, fields}`), que F9 usará para sincronizar puntos.

Cubre: FR-58 (contrato), NFR-9.

Done when: el linter OpenAPI de CI pasa y `wallet.md` incluye un ejemplo de cada request del Web Service de Apple.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Documenta protocolos externos conocidos; poca decisión propia.
- **Dependencies**: F6.7.T1
- **Files**:
  - `contracts/openapi/admin-v1/wallet.yaml`
  - `contracts/dsl/wallet.md`

### F7.1.T5 — Contrato de connectors: conexiones y audiencias

Escribir `contracts/openapi/admin-v1/connectors.yaml` (C3, dueño connectors) con la sección de audiencias: `GET|POST /admin/v1/connections` (kind `meta_ads|google_ads|fake_ads`, credenciales write-only, estado), `POST /admin/v1/connections/{id}/test`, `GET|POST /admin/v1/audiences` (segment_id → conexión, agenda de sync), `POST /admin/v1/audiences/{id}/sync` y `GET /admin/v1/audiences/{id}/runs` (agregados, quitados, errores). Dejar el archivo organizado por tags para que F10.1 sume e-commerce y webhooks sin reescribirlo. Documentar que los identificadores se normalizan (email en minúsculas y sin espacios; teléfono E.164) y se envían como SHA-256.

Cubre: FR-59 (contrato), NFR-9.

Done when: el linter OpenAPI de CI pasa y `packages/ts-contracts` regenera sin errores.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 2h
- **Reason**: Contrato CRUD con convenciones fijas.
- **Dependencies**: F6.7.T1
- **Files**:
  - `contracts/openapi/admin-v1/connectors.yaml`

## F7.2 — Package: SMS

### F7.2.T1 — Adaptador SMS en dispatcher

Implementar en `internal/channels/sms` la interfaz `Channel` de `channel-adapters.md` con dos adaptadores: `twilio` (Messaging API, credenciales por tenant desde la configuración de canal, `StatusCallback` apuntando a `/t/wh/twilio`) y `fake` (guarda los mensajes en Redis `fake:sms:<tenant>` para los tests y el e2e). Antes de enviar: consentimiento SMS (field 32) y supresión con la caché existente, número E.164 válido, render Liquid solo de texto y conteo de segmentos (GSM-7 160/153, UCS-2 70/67), rechazando más de 10 segmentos. Registrar el canal `sms` en `internal/channels/registry.go`. Publica `messages.sent|failed` con los errores tipados.

Cubre: FR-54, NFR-11 (idempotencia heredada del pipeline).

Done when: `go test ./internal/channels/sms/...` pasa con casos de conteo GSM-7 vs UCS-2 (con emoji), contacto sin consentimiento no enviado, número inválido → `InvalidRecipient`, y un envío idempotente repetido que no duplica en el fake.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Adaptador con reglas bien especificadas sobre el pipeline existente.
- **Dependencies**: F7.1.T2
- **Files**:
  - `services/dispatcher/internal/channels/sms/`
  - `services/dispatcher/internal/channels/registry.go`

### F7.2.T2 — SMS entrante y estados de entrega en tracker

Agregar `POST /t/wh/twilio` en tracker: valida la firma `X-Twilio-Signature` (HMAC-SHA1 con el auth token del tenant; firma inválida → 403) y distingue estado de entrega (publica `messages.delivered|failed`) de SMS entrante (palabras clave de `channel-adapters.md`, sin distinguir mayúsculas ni acentos: baja → `messages.unsubscribed` con `channel=sms`, alta → `consent.changed` vía core). Extender el consumidor de supresión de core (F4.4) para aplicar bajas de SMS y push sobre los fields 32 y 33 con origen `inbound_sms` o `push`. Registrar la ruta en `cmd/tracker/main.go`.

Cubre: FR-54 (STOP → opt-in SMS = no), NFR-9.

Done when: `go test` en tracker pasa con firma válida e inválida, "stop", "Parar" y "SAIR" como baja; y el test del consumidor de core verifica que un `messages.unsubscribed` de SMS deja el field 32 en 2 con historial de consentimiento.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Webhook con validación de firma conocida; sin diseño nuevo.
- **Dependencies**: F7.1.T2
- **Files**:
  - `services/tracker/internal/inbound/sms/`
  - `services/tracker/cmd/tracker/main.go`
  - `services/core/src/modules/contacts/consumers/suppression.consumer.ts`
  - `services/core/src/modules/contacts/consumers/suppression.consumer.spec.ts`

### F7.2.T3 — Campañas SMS y envío transaccional

Crear el módulo `sms` en campaigns: campañas con `channel=sms` (texto con personalización, remitente, audiencia, agenda; reutiliza el lanzamiento de F4.5 y sus exclusiones con el consentimiento de SMS), vista previa con conteo de segmentos vía `POST /internal/v1/render` del dispatcher, y `POST /api/v3/sms` transaccional (contacto por `key_id` + texto o plantilla + contexto). El registro del módulo en `app.module.ts` lo hace F7.8.T1.

Cubre: FR-54.

Done when: los tests del módulo verifican que el lanzamiento de una campaña SMS publica `messages.send.requested` con `channel=sms` solo para contactos con consentimiento de SMS, y que la API transaccional con un contacto inexistente devuelve un `replyCode` de error.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Variante de canal sobre el flujo de campañas existente.
- **Dependencies**: F7.1.T2
- **Files**:
  - `services/campaigns/src/modules/sms/`

## F7.3 — Package: push e inbox backend

### F7.3.T1 — Módulo devices en core

Crear el módulo `devices` en core (C11) con el esquema Prisma `mobile.prisma`, que incluye `devices`, `inbox_messages` (Data model) y `mobile_apps` (app_key, plataforma, tenant), con RLS. Implementar las rutas de dispositivos e identify de `mobile.yaml` con auth por `app_key` (rate limit, un token se reasigna si cambia de contacto), el CRUD admin de apps y los internos `devices/lookup` y `devices/invalidate`. Un consumidor de `messages.failed` con error `InvalidRecipient` en canal push desactiva el token. `identify` vincula `anonymous_id` → contacto publicando `identity.linked` (C1).

Cubre: FR-55, NFR-8, NFR-9.

Done when: los tests de integración cubren registro, reasignación de token a otro contacto, lookup por contacto y plataforma, invalidación por evento y rechazo de un `app_key` de otro tenant.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Módulo NestJS con auth por clave pública; patrón conocido.
- **Dependencies**: F7.1.T1
- **Files**:
  - `services/core/src/modules/devices/`
  - `services/core/prisma/schema/mobile.prisma`
  - `services/core/prisma/migrations/`

### F7.3.T2 — Módulo inbox en core

Crear el módulo `inbox` en core sobre `inbox_messages` (esquema de F7.3.T1): interno `POST /internal/v1/inbox` (tipo `inbox|inapp`, título, cuerpo, imagen, action_url, expiración, `message_id` para idempotencia), `GET /api/v3/mobile/inbox` paginado con no leídos primero, excluyendo expirados, `POST .../read` (publica `messages.opened` con el `message_id`) y `GET /api/v3/mobile/inapp`, que entrega los pendientes y los marca entregados.

Cubre: FR-56.

Done when: los tests de integración verifican idempotencia por `message_id`, orden y expiración de la bandeja, que marcar leído publica `messages.opened` una sola vez, y que un in-app se entrega una sola vez.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: CRUD con reglas simples.
- **Dependencies**: F7.3.T1
- **Files**:
  - `services/core/src/modules/inbox/`

### F7.3.T3 — Adaptadores push, Web Push e inbox en dispatcher

Implementar en `internal/channels/push` los adaptadores `fcm` (HTTP v1 con OAuth de cuenta de servicio), `apns` (HTTP/2 con JWT ES256 de la llave `.p8`, renovado cada 50 min), `webpush` (VAPID con `SherClockHolmes/webpush-go`) y `fake`. Para cada mensaje push: consentimiento (field 33), `devices/lookup`, render Liquid de título y cuerpo, `tracking_token` (C9) en el payload y envío a todos los dispositivos activos del contacto. Un token rechazado por el proveedor produce `InvalidRecipient` para ese dispositivo sin fallar el mensaje. En `internal/channels/inbox`, adaptador que llama a `POST /internal/v1/inbox` para `inbox` e `inapp`. Registrar `push`, `inbox` e `inapp` en `registry.go`. Las credenciales se leen descifradas desde la configuración de canal y nunca se loguean.

Cubre: FR-55, FR-56, NFR-9.

Done when: `go test ./internal/channels/push/... ./internal/channels/inbox/...` pasa con servidores `httptest` que emulan FCM, APNs (HTTP/2) y Web Push: firma JWT verificable, token inválido desactivado sin fallar el resto, y payload con tracking token.

- **Model**: claude/claude-opus-5
- **Estimate**: 4h
- **Reason**: Firma JWT ES256, OAuth de cuenta de servicio y manejo de credenciales sensibles.
- **Dependencies**: F7.1.T1, F7.1.T2, F7.2.T1
- **Files**:
  - `services/dispatcher/internal/channels/push/`
  - `services/dispatcher/internal/channels/inbox/`
  - `services/dispatcher/internal/channels/registry.go`

### F7.3.T4 — Campañas push y envío transaccional

Crear el módulo `push` en campaigns: campañas con `channel=push` (título, cuerpo, imagen, deep link, opción "también en bandeja", audiencia, agenda) sobre el lanzamiento de F4.5 con exclusión por consentimiento de push, y `POST /api/v3/push` transaccional. Si "también en bandeja" está activo, publica un segundo `messages.send.requested` con `channel=inbox`. El registro en `app.module.ts` lo hace F7.8.T1.

Cubre: FR-55, FR-56.

Done when: los tests del módulo verifican los `messages.send.requested` publicados (uno o dos por contacto según la opción) y la exclusión por consentimiento.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Variante de canal sobre campañas existentes.
- **Dependencies**: F7.1.T2
- **Files**:
  - `services/campaigns/src/modules/push/`

### F7.3.T5 — Web Push en el web-sdk

Agregar al web-sdk el comando `oe('push.subscribe', {vapid_public_key})`: pide permiso solo tras un gesto del usuario, registra el service worker `oe-sw.js`, crea la suscripción y la registra con `POST /api/v3/mobile/devices` (`platform=web`). El service worker muestra la notificación, reporta la apertura con `GET /t/o/{token}` y abre `deep_link` al hacer click. Registrar el comando en `src/index.ts` y construir `oe-sw.js` como artefacto separado del bundle principal.

Cubre: FR-55 (navegadores).

Done when: el test de navegador (Playwright con permisos concedidos) suscribe, recibe un push simulado en el service worker, muestra la notificación y reporta la apertura; `sdk.js` sigue < 10 KB gz.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: API de navegador estándar.
- **Dependencies**: F7.1.T1
- **Files**:
  - `packages/web-sdk/src/push/`
  - `packages/web-sdk/src/index.ts`

## F7.4 — Package: Flutter SDK y demo-app

### F7.4.T1 — SDK Flutter: núcleo, eventos y registro de dispositivo

Crear el paquete `sdk/flutter` (`open_emarsys`): `OpenEmarsys.init(appKey, host)`, `identify(email|externalId)`, `track(name, props)`, `view(itemId)`, `purchase(...)`, con cola persistente offline (`shared_preferences` o archivo) y envío en lotes a `/c/v1/collect` (C10), `anonymous_id` estable, y `registerDevice(token, platform)` según `mobile.yaml`. Exportar la API pública desde `lib/open_emarsys.dart`.

Cubre: FR-55 (base), FR-17 (eventos desde app).

Done when: `flutter test` en `sdk/flutter` pasa con un cliente HTTP mockeado: lotes enviados, reintento tras fallo de red sin perder eventos e identify antes y después de eventos anónimos.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: SDK cliente con cola offline; stack Flutter del autor.
- **Dependencies**: F7.1.T1
- **Files**:
  - `sdk/flutter/pubspec.yaml`
  - `sdk/flutter/lib/open_emarsys.dart`
  - `sdk/flutter/lib/src/core/`
  - `sdk/flutter/test/core/`

### F7.4.T2 — SDK Flutter: push

Agregar `lib/src/push/`: integración con `firebase_messaging` (token FCM en Android; token APNs vía `getAPNSToken` en iOS, coherente con los adaptadores de F7.3.T3), permisos, registro y refresh de token, manejo en foreground, background y terminated, reporte de apertura con el `tracking_token` y callback `onDeepLink`. Exportarlo desde `open_emarsys.dart`.

Cubre: FR-55.

Done when: `flutter test` pasa con `firebase_messaging` mockeado: el refresh de token re-registra el dispositivo y abrir una notificación llama a la URL de apertura y al callback de deep link.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Integración con plugin conocido y ciclos de vida de la app.
- **Dependencies**: F7.4.T1
- **Files**:
  - `sdk/flutter/lib/src/push/`
  - `sdk/flutter/lib/open_emarsys.dart`
  - `sdk/flutter/test/push/`

### F7.4.T3 — SDK Flutter: bandeja e in-app

Agregar `lib/src/inbox/` (`fetchInbox()`, `markRead(id)`, stream de no leídos) y `lib/src/inapp/` (consulta de `/api/v3/mobile/inapp` al volver a foreground y widget overlay accesible con imagen, texto, botón y cierre, que reporta impresión y click por collect). Exportarlos desde `open_emarsys.dart`.

Cubre: FR-56.

Done when: `flutter test` pasa con widget tests: la bandeja lista y marca leído, el overlay se muestra una vez, se cierra con el botón y tiene semántica accesible.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: UI y cliente HTTP con reglas simples.
- **Dependencies**: F7.4.T2
- **Files**:
  - `sdk/flutter/lib/src/inbox/`
  - `sdk/flutter/lib/src/inapp/`
  - `sdk/flutter/lib/open_emarsys.dart`
  - `sdk/flutter/test/inbox/`

### F7.4.T4 — App demo Flutter

Crear `apps/demo-app`: app Flutter con login contra los usuarios de demo-shop, listado de productos del catálogo semilla, detalle con `view` y compra con `purchase`, pantalla de bandeja, permiso de push y deep links a producto, usando el SDK por path. Incluir un flavor `fake` que apunta al stack de Compose.

Cubre: FR-55, FR-56 (aceptación en la app demo).

Done when: `flutter test` pasa con un integration test en modo `fake` que hace login, recibe un mensaje de bandeja creado por API y lo marca leído; `flutter build apk --flavor fake` termina.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: App demo sin lógica de dominio propia.
- **Dependencies**: F7.4.T3
- **Files**:
  - `apps/demo-app/`

## F7.5 — Package: web pieces

### F7.5.T1 — Módulo web-pieces en content

Crear el módulo `web-pieces` en content según `web-piece.schema.json` y `pieces.yaml`: CRUD admin con validación del esquema, contenido como árbol de bloques compilado a HTML sanitizado (sin `<script>` ni handlers inline), estados borrador/activa/pausada, y el interno `GET /internal/v1/web-pieces/active?tenant_id` con ETag para la caché de personalize. Esquema Prisma en `prisma/schema/web-pieces.prisma` con su migración. El registro en `app.module.ts` lo hace F7.8.T1.

Cubre: FR-57, NFR-9.

Done when: los tests del módulo verifican CRUD, rechazo de una pieza inválida contra el esquema, que el HTML compilado elimina scripts y handlers, y 304 con ETag sin cambios.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: CRUD + compilación reutilizando el compilador de content.
- **Dependencies**: F7.1.T3
- **Files**:
  - `services/content/src/modules/web-pieces/`
  - `services/content/prisma/schema/web-pieces.prisma`
  - `services/content/prisma/migrations/`

### F7.5.T2 — Endpoint /p/v1/pieces en personalize

Implementar en `internal/pieces` el endpoint de `pieces.yaml`: auth por `tenant_key`, caché de piezas activas por tenant (refresco por ETag cada 30 s), filtro por vigencia y `page_url_matches`, y audiencia por segmento: con contacto identificado vía `identity_links`, `segments.IsMember` por gRPC con caché Redis de 5 min; un visitante anónimo solo recibe piezas sin audiencia. Devuelve piezas ordenadas por prioridad. Registrar la ruta en `cmd/personalize/main.go`.

Cubre: FR-57.

Done when: `go test ./internal/pieces/...` pasa con segments y content fakes: un miembro del segmento recibe la pieza, un no miembro y un anónimo no la reciben, y una pieza vencida se excluye.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Endpoint de lectura con cachés y reglas claras.
- **Dependencies**: F7.1.T3
- **Files**:
  - `services/personalize/internal/pieces/`
  - `services/personalize/cmd/personalize/main.go`

### F7.5.T3 — Render de piezas en el web-sdk

Agregar el comando `oe('pieces')`: consulta `/p/v1/pieces` al cargar y en cada `page()`, evalúa las reglas (`delay_seconds`, `scroll_percent`, `exit_intent` por `mouseout` hacia arriba en desktop), respeta la frecuencia por visitante con `localStorage` (con try/catch) y renderiza en shadow DOM: overlay como `dialog` modal con foco atrapado, cierre con Esc y botón con etiqueta; banner y barra sin bloquear el scroll. Reporta impresión, cierre y click por collect. Registrar en `src/index.ts` como chunk diferido.

Cubre: FR-57, NFR-15.

Done when: los tests de navegador verifican cada regla de disparo, que la frecuencia `once` no repite tras recargar, que el overlay es operable solo con teclado y que axe no reporta violaciones; `sdk.js` sigue < 10 KB gz.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: UI accesible en DOM ajeno con reglas explícitas.
- **Dependencies**: F7.1.T3, F7.3.T5
- **Files**:
  - `packages/web-sdk/src/pieces/`
  - `packages/web-sdk/src/index.ts`

## F7.6 — Package: wallet

### F7.6.T1 — Pases de Apple Wallet en content

Crear el módulo `wallet` en content con esquema Prisma `wallet.prisma` (`wallet_templates`, `wallet_passes` con serial, contact_id, authentication token y `updated_at`). Implementar el CRUD de plantillas de `admin-v1/wallet.yaml`, la generación de `.pkpass` con `passkit-generator` (certificados y pass type id por tenant desde secretos cifrados; nunca en el repo), la personalización de campos con datos del contacto (lookup interno a core), el endpoint firmado `GET /wallet/v1/passes/{token}` y el Apple PassKit Web Service de `wallet.md` (registro y baja de dispositivos, seriales actualizados, pase actualizado). Con credenciales ausentes, el adaptador `fake` genera un pase sin firmar marcado como de prueba.

Cubre: FR-58, NFR-9.

Done when: los tests del módulo generan un `.pkpass` con certificados de prueba autogenerados cuyo `manifest.json` y firma verifican, el Web Service responde 401 con un authentication token inválido, y un token de link alterado responde 403.

- **Model**: claude/claude-opus-5
- **Estimate**: 4h
- **Reason**: Firma PKCS#7, certificados y autenticación de un protocolo externo.
- **Dependencies**: F7.1.T4, F7.5.T1
- **Files**:
  - `services/content/src/modules/wallet/`
  - `services/content/prisma/schema/wallet.prisma`
  - `services/content/prisma/migrations/`

### F7.6.T2 — Google Wallet en content

Agregar `wallet/google`: creación de clases y objetos (`offer` para cupón, `loyalty` para tarjeta) vía Google Wallet REST API con cuenta de servicio, link "Save to Google Wallet" con JWT firmado RS256, y adaptador `fake` sin credenciales. El endpoint `GET /wallet/v1/passes/{token}` redirige a este link cuando el user-agent es Android.

Cubre: FR-58.

Done when: los tests verifican el JWT de "Save to Google Wallet" (claims y firma con una llave de prueba), la llamada de creación contra un `nock` de la API y la redirección por user-agent.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Integración con API documentada sobre el módulo de F7.6.T1.
- **Dependencies**: F7.6.T1
- **Files**:
  - `services/content/src/modules/wallet/google/`

### F7.6.T3 — Actualización de pases

Implementar el interno `POST /internal/v1/wallet/passes/update` de `wallet.md`: recalcula los campos del pase del contacto, incrementa `updated_at` y notifica: para Apple, push vacío por APNs al pass type id de cada dispositivo registrado; para Google, `PATCH` del objeto. Idempotente si los campos no cambiaron. Es el punto que F9 usará para sincronizar puntos.

Cubre: FR-58 (el cambio actualiza el pase).

Done when: los tests verifican que un cambio de campo dispara un push APNs por dispositivo (servidor HTTP/2 simulado) y un PATCH a Google, y que repetir el mismo update no notifica.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Orquestación de notificaciones sobre adaptadores ya hechos.
- **Dependencies**: F7.6.T2
- **Files**:
  - `services/content/src/modules/wallet/updates/`

## F7.7 — Package: connectors y audiencias de Ads

### F7.7.T1 — Scaffold del servicio connectors

Crear `services/connectors` (NestJS con `packages/ts-common`): `main.ts`, `app.module.ts`, auth JWT y permisos `connectors:*`, esquema Prisma `connectors.prisma` con `connections`, `audiences`, `sync_state` y `audience_runs` (RLS) y cifrado de credenciales AES-256-GCM con clave derivada de la maestra (`src/common/crypto/`; las credenciales nunca salen por la API). CRUD de conexiones con `test`. Dockerfile y health check.

Cubre: FR-59 (base), NFR-8, NFR-9.

Done when: los tests verifican que las credenciales se guardan cifradas y la API nunca las devuelve, el acceso cruzado entre tenants es rechazado, y `docker build services/connectors` termina.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Scaffold con cifrado estándar de la librería común.
- **Dependencies**: F7.1.T5
- **Files**:
  - `services/connectors/package.json`
  - `services/connectors/tsconfig.json`
  - `services/connectors/src/main.ts`
  - `services/connectors/src/app.module.ts`
  - `services/connectors/src/common/crypto/`
  - `services/connectors/src/modules/connections/`
  - `services/connectors/prisma/schema/connectors.prisma`
  - `services/connectors/Dockerfile`

### F7.7.T2 — Sincronización de audiencias y adaptador fake

Crear el módulo `audiences`: vínculo segmento → conexión, sync programado con BullMQ repetible (A3) y manual. Cada corrida pide `Materialize` a segments por gRPC, pagina miembros, pide email y teléfono a core (`contacts/lookup`), normaliza y hashea con SHA-256, calcula altas y bajas contra el último `run_id` sincronizado (diferencia en ClickHouse `segment_members`) y las envía por lotes a través de la interfaz `AudienceAdapter` (`create`, `add`, `remove`). Registra agregados, quitados y errores en `audience_runs`. Incluye el adaptador `fake` en memoria o Redis y el índice de adaptadores con `fake` registrado.

Cubre: FR-59.

Done when: los tests de integración con segments fake verifican que la primera corrida agrega N, que tras sacar 2 contactos del segmento la segunda quita esos 2, que los identificadores enviados son SHA-256 de valores normalizados y que una corrida fallida no avanza el `run_id` sincronizado.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Diff incremental con reglas precisas; patrón de jobs conocido.
- **Dependencies**: F7.7.T1
- **Files**:
  - `services/connectors/src/modules/audiences/`

### F7.7.T3 — Adaptador Meta Custom Audiences

Implementar `adapters/meta`: crear Custom Audience (subtype CUSTOM, `customer_file_source`), `POST /{audience_id}/users` y `DELETE` con schema `EMAIL_SHA256` y `PHONE_SHA256` en lotes de 10.000, manejo de rate limit (código 17/80004) con backoff y errores de token vencido como error permanente de conexión. Registrarlo en el índice de adaptadores.

Cubre: FR-59.

Done when: los tests contra un `nock` de Graph API verifican el formato de los payloads, el partido en lotes de 10.000 y el reintento ante rate limit.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Cliente de API externa documentada.
- **Dependencies**: F7.7.T2
- **Files**:
  - `services/connectors/src/modules/audiences/adapters/meta/`
  - `services/connectors/src/modules/audiences/adapters/index.ts`

### F7.7.T4 — Adaptador Google Customer Match

Implementar `adapters/google`: crear la `UserList` de Customer Match y enviar altas y bajas con `OfflineUserDataJob` (create → addOperations en lotes → run, con polling del estado) por la API REST de Google Ads, usando OAuth refresh token y developer token de la conexión, con emails y teléfonos hasheados. Registrarlo en el índice de adaptadores.

Cubre: FR-59.

Done when: los tests contra un `nock` de Google Ads API verifican la secuencia create → addOperations → run y el manejo de un job fallido como error de corrida.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 3h
- **Reason**: Cliente de API externa documentada.
- **Dependencies**: F7.7.T3
- **Files**:
  - `services/connectors/src/modules/audiences/adapters/google/`
  - `services/connectors/src/modules/audiences/adapters/index.ts`

## F7.8 — Package: admin-web omnicanal y e2e

### F7.8.T1 — Cierre de F7: wiring y e2e omnicanal

Registrar los módulos nuevos en sus `app.module.ts`: `devices` e `inbox` en core, `sms` y `push` en campaigns, `web-pieces` y `wallet` en content. Crear `deploy/compose/services/connectors.yml` e incluirlo en `docker-compose.yml`. Agregar las rutas Traefik de `/api/v3/mobile`, `/api/v3/sms`, `/api/v3/push`, `/t/wh/twilio`, `/p/v1/pieces`, `/wallet/`, `/admin/v1/channels`, `/admin/v1/web-pieces`, `/admin/v1/wallet`, `/admin/v1/connections` y `/admin/v1/audiences`. Configurar todos los adaptadores en modo `fake` por defecto. Escribir `tests/e2e/channels/`: (1) programa email → espera → SMS → push + bandeja; el fake de SMS y el de push reciben los mensajes y la bandeja de la app demo muestra el mensaje (FR-54, FR-55, FR-56); (2) respuesta STOP firmada al webhook deja el opt-in SMS en "no" y el siguiente envío se excluye (FR-54); (3) overlay para "compradores de 30 días" visible solo para un comprador identificado en demo-shop (FR-57); (4) pase generado, actualización de un campo y verificación de la notificación (FR-58); (5) sync de audiencia fake refleja altas y bajas del segmento (FR-59).

Cubre: FR-54 a FR-59 (aceptación), NFR-13.

Done when: `docker compose up` con los perfiles de F7 levanta sano y `pnpm test:e2e --filter channels` pasa los cinco escenarios.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 6h
- **Reason**: Integración amplia pero mecánica con escenarios definidos.
- **Dependencies**: F7.2.T2, F7.2.T3, F7.3.T2, F7.3.T3, F7.3.T4, F7.4.T4, F7.5.T1, F7.5.T2, F7.5.T3, F7.6.T3, F7.7.T4, F7.8.T2, F7.8.T3, F7.8.T4
- **Files**:
  - `services/core/src/app.module.ts`
  - `services/campaigns/src/app.module.ts`
  - `services/content/src/app.module.ts`
  - `deploy/compose/services/connectors.yml`
  - `deploy/compose/docker-compose.yml`
  - `deploy/traefik/dynamic/channels.yml`
  - `tests/e2e/channels/`

### F7.8.T2 — admin-web: SMS, push y configuración de canales

Pantallas en `(console)/channels/`: `settings/` (remitentes SMS y credenciales de push por app, campos de secreto write-only con estado "configurado", y apps móviles con su `app_key`), `sms/` (compositor con personalización, contador de caracteres y segmentos en vivo, prueba a un número, asistente de campaña reutilizando audiencia y agenda de F4.6) y `push/` (título, cuerpo, imagen, deep link, "también en bandeja", vista previa Android/iOS). Crear `src/nav/channels.ts` con las entradas de todo F7 (SMS, Push, Piezas web, Wallet, Audiencias, Configuración) y los mensajes es/pt/en de este paquete en `messages/*/channels.json`.

Cubre: FR-54, FR-55, FR-56, NFR-15, NFR-16.

Done when: los tests Playwright contra mocks crean una campaña SMS viendo el conteo de segmentos cambiar con un emoji y una campaña push con bandeja; axe sin violaciones AA.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: Pantallas con patrones ya existentes en la consola.
- **Dependencies**: F7.1.T1, F7.1.T2
- **Files**:
  - `apps/admin-web/src/app/[locale]/(console)/channels/settings/`
  - `apps/admin-web/src/app/[locale]/(console)/channels/sms/`
  - `apps/admin-web/src/app/[locale]/(console)/channels/push/`
  - `apps/admin-web/src/nav/channels.ts`
  - `apps/admin-web/messages/es/channels.json`
  - `apps/admin-web/messages/pt/channels.json`
  - `apps/admin-web/messages/en/channels.json`

### F7.8.T3 — admin-web: piezas web y wallet

Pantallas `(console)/channels/web-pieces/` (editor de pieza con los bloques de content, tipo y posición, reglas de disparo, selector de segmento, frecuencia, vigencia y vista previa en un iframe sandbox) y `(console)/channels/wallet/` (plantillas de cupón y tarjeta, mapeo de campos a variables, vista previa y link de prueba). Mensajes en `messages/*/channels-web.json`.

Cubre: FR-57, FR-58, NFR-15.

Done when: los tests Playwright contra mocks crean y activan una pieza con audiencia y una plantilla de wallet; la definición enviada valida contra `web-piece.schema.json`; axe sin violaciones AA.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: UI de configuración reutilizando el editor de bloques.
- **Dependencies**: F7.1.T3, F7.1.T4
- **Files**:
  - `apps/admin-web/src/app/[locale]/(console)/channels/web-pieces/`
  - `apps/admin-web/src/app/[locale]/(console)/channels/wallet/`
  - `apps/admin-web/messages/es/channels-web.json`
  - `apps/admin-web/messages/pt/channels-web.json`
  - `apps/admin-web/messages/en/channels-web.json`

### F7.8.T4 — admin-web: audiencias y nodos SMS/push en programas

Pantalla `(console)/channels/audiences/`: conexiones (alta con credenciales write-only y prueba), vínculos segmento → conexión con agenda, historial de corridas con agregados, quitados y errores, y botón "Sincronizar ahora". En el editor de programas (F5.5), extender el panel del nodo `send` para elegir canal `email|sms|push|inbox` con los campos de cada uno (C7). Mensajes en `messages/*/channels-audiences.json`.

Cubre: FR-59, FR-54, FR-55 (programas omnicanal), NFR-15.

Done when: los tests Playwright contra mocks vinculan un segmento a una conexión fake y ven una corrida; el test de componente del nodo `send` genera un nodo SMS que valida contra `program.schema.json`.

- **Model**: claude/claude-sonnet-5
- **Estimate**: 4h
- **Reason**: UI sobre contratos existentes.
- **Dependencies**: F7.1.T2, F7.1.T5
- **Files**:
  - `apps/admin-web/src/app/[locale]/(console)/channels/audiences/`
  - `apps/admin-web/src/components/program-editor/nodes/send/`
  - `apps/admin-web/messages/es/channels-audiences.json`
  - `apps/admin-web/messages/pt/channels-audiences.json`
  - `apps/admin-web/messages/en/channels-audiences.json`
