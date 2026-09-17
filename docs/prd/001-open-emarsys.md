---
type: prd
project_id: open-emarsys
version: 0.1
generated_by: orch-prd
generated_at: 2026-09-17
title: open-emarsys — plataforma de customer engagement
---

# open-emarsys — plataforma de customer engagement

## Problem

Emarsys (SAP Engagement Cloud desde febrero de 2026) es una de las plataformas de marketing automation omnicanal más completas del mercado, pero es una caja negra: cerrada, cara y sin acceso a cómo resuelve los problemas difíciles del dominio. Esos problemas son segmentar millones de contactos por comportamiento en segundos, ejecutar programas con esperas de semanas sin perder estado, enviar y medir millones de mensajes, y servir predicciones en tiempo real.

Quien quiere dominar ese dominio —como ingeniero o como consultor de martech— solo puede leer documentación de usuario. No hay una implementación abierta, moderna y completa que se pueda correr, romper y medir.

open-emarsys es un clon funcional de Emarsys, construido como proyecto de estudio y portafolio. Replica sus módulos con una arquitectura de microservicios que separa el plano de control (gestión) del plano de datos (alto volumen), y suma IA predictiva y generativa. Corre completo en una sola máquina con Docker Compose.

## Users

- **Marketer (usuario de la consola)** — crea segmentos, contenidos, campañas y programas automáticos, y mide resultados, sin escribir código.
- **Administrador del tenant** — da de alta usuarios, roles, dominios de envío y credenciales de API de su cuenta.
- **Desarrollador integrador** — conecta el sitio, la app o el e-commerce del cliente vía API, script de tracking y webhooks.
- **Operador de la plataforma** — crea tenants, observa la salud de los servicios y los límites de uso.
- **Contacto final** — recibe los mensajes, gestiona sus preferencias y ejerce sus derechos GDPR.
- **Estudiante / autor (Alejandro)** — usa el sistema para aprender, medir y demostrar decisiones de arquitectura.

## Goals

- G1 — Cubrir el ciclo completo de Emarsys: un evento de un sitio de prueba dispara un programa que envía un email personalizado con recomendaciones, y la compra resultante aparece atribuida en el reporte de la campaña.
- G2 — Plano de datos a escala de estudio en un solo host de 16 GB: 1 M de contactos y 100 M de eventos por tenant, ingesta sostenida de 2.000 eventos/s.
- G3 — Cada módulo de Emarsys listado en el Rx (`docs/rx/emarsys.md`) tiene su equivalente funcional o está declarado como non-goal.
- G4 — IA predictiva (recomendaciones, churn, send time) servida en línea bajo 50 ms, e IA generativa integrada en la creación de contenido y segmentos.
- G5 — `docker compose up` levanta todo, con datos semilla de una tienda ficticia, en menos de 10 minutos desde un clon limpio.

## Non-goals

- **CRM de ventas o soporte** (pipeline de deals, tickets, inbox): Emarsys tampoco lo tiene.
- **Entregabilidad de producción** (warm-up real de IPs, feedback loops con ISPs, reputación a escala): se simula; los envíos reales se limitan a un proveedor transaccional.
- **SDKs nativos iOS/Android**: el SDK móvil es Flutter; el web SDK cubre navegadores.
- **Facturación, planes y cobro** de tenants.
- **Integración con SAP** (Business Data Cloud, ERP, Joule): es propia de la Enterprise Edition.
- **Alta disponibilidad multi-región y Kubernetes productivo**: el objetivo es un host; k3s queda como ejercicio opcional.
- **Compatibilidad byte a byte con la API de Emarsys**: se replica su forma, no se garantiza que un cliente de Emarsys funcione sin cambios.

## Functional requirements

### Plataforma (M0)

- **FR-1** — El operador crea un tenant con nombre, zona horaria, idioma por defecto y límites de uso. *Acceptance:* el tenant nuevo aparece en el listado del operador y sus usuarios no ven datos de ningún otro tenant.
- **FR-2** — El administrador invita usuarios por email y les asigna roles con permisos por módulo (ver, editar, lanzar). *Acceptance:* un usuario con rol "solo lectura" en campañas recibe 403 al intentar lanzar una.
- **FR-3** — Los usuarios inician sesión en la consola con email y contraseña, con MFA TOTP opcional. *Acceptance:* un usuario con MFA activo no accede sin el código; cinco intentos fallidos bloquean la cuenta 15 minutos.
- **FR-4** — El administrador crea credenciales de API (client id + secret) con scopes, y las revoca. *Acceptance:* un token obtenido con client credentials accede solo a los scopes otorgados y deja de funcionar al revocar la credencial.
- **FR-5** — La consola está disponible en español, portugués e inglés, según la preferencia del usuario. *Acceptance:* cambiar el idioma traduce navegación, formularios y mensajes de error sin recargar datos.
- **FR-6** — Toda acción de escritura de un usuario o credencial queda en un log de auditoría consultable por el administrador. *Acceptance:* borrar un contacto genera una entrada con actor, fecha, recurso y tenant.

### Contactos (M1)

- **FR-7** — El administrador define campos custom de contacto (texto, número, fecha, booleano, single choice, multi choice), cada uno con un field ID numérico estable; los campos de sistema tienen IDs fijos (1 nombre, 2 apellido, 3 email, 31 opt-in email, etc.). *Acceptance:* un campo creado recibe un ID que no cambia al renombrarlo y es usable por API.
- **FR-8** — La API crea, actualiza y borra contactos en lotes de hasta 1.000, identificándolos por cualquier campo único elegido en `key_id`. *Acceptance:* un lote con 998 válidos y 2 inválidos persiste los 998 y devuelve los 2 errores por posición.
- **FR-9** — La API consulta contactos por clave y devuelve los campos pedidos por field ID. *Acceptance:* pedir los campos 1 y 3 de tres emails devuelve exactamente esos campos para los tres.
- **FR-10** — El marketer busca, ve y edita contactos en la consola, incluida una ficha con perfil, consentimientos y timeline de actividad. *Acceptance:* buscar por email encuentra el contacto y la ficha muestra sus últimos 50 eventos.
- **FR-11** — Se importan contactos desde CSV (hasta 1 M de filas) con mapeo de columnas a campos, modo crear/actualizar y reporte de errores descargable. *Acceptance:* un CSV de 1 M de filas termina sin intervención y el reporte lista cada fila rechazada con su motivo.
- **FR-12** — Se exportan contactos (todos, un segmento o una lista) con los campos elegidos, de forma asíncrona y con aviso al terminar. *Acceptance:* la API devuelve un `job_id`; al consultar el job terminado entrega un enlace de descarga que expira.
- **FR-13** — Existen listas estáticas de contactos, gestionables por consola, import y API. *Acceptance:* agregar 500 contactos por API a una lista hace que su conteo sea 500.
- **FR-14** — El consentimiento se guarda por canal (email, SMS, push) con valor, fecha, origen y texto aceptado. *Acceptance:* la ficha del contacto muestra el historial de cambios de consentimiento de cada canal.
- **FR-15** — Un contacto puede ejercer derecho de acceso (export de todos sus datos) y de olvido (borrado de perfil y anonimización de eventos). *Acceptance:* tras el borrado, ninguna búsqueda, segmento ni export devuelve el contacto y sus eventos no contienen datos personales.
- **FR-16** — El administrador define tablas de datos relacionales (ej. mascotas, vehículos) vinculadas a contactos, con carga por CSV y API. *Acceptance:* un segmento puede filtrar "contactos con una mascota de especie perro".

### Comportamiento (M2)

- **FR-17** — Un script JS insertable registra vistas de página y de producto, búsquedas, carrito, compras e identificación del visitante. *Acceptance:* en el sitio demo, agregar un producto al carrito genera un evento `cart` visible en la timeline del contacto en menos de 5 s.
- **FR-18** — Los eventos de un visitante anónimo se asocian al contacto cuando se identifica (login, formulario, click en email). *Acceptance:* las vistas previas al login aparecen en la timeline del contacto después de identificarse.
- **FR-19** — El administrador define External Events con nombre, y la API los dispara para uno o varios contactos con un payload JSON. *Acceptance:* disparar `order_shipped` con `{tracking: "X"}` queda registrado con su payload y es usable como trigger.
- **FR-20** — Se ingieren órdenes (id, fecha, contacto, ítems, montos, moneda) por API y CSV. *Acceptance:* una orden cargada aparece en la timeline y suma al revenue total del contacto.
- **FR-21** — La ingesta descarta eventos duplicados y de bots conocidos. *Acceptance:* reenviar el mismo evento con el mismo id no duplica conteos; un user-agent de crawler conocido no genera eventos.

### Segmentos (M3)

- **FR-22** — El marketer construye segmentos con criterios de perfil (campos, listas, datos relacionales) y de comportamiento (abrió, clickeó, compró, vio producto, evento externo, dentro de una ventana de tiempo), combinables con AND/OR/NOT y grupos anidados. *Acceptance:* "compró en los últimos 30 días Y NO abrió ningún email en 60 días" devuelve exactamente los contactos del dataset de prueba que cumplen ambas condiciones.
- **FR-23** — El builder muestra el conteo estimado del segmento mientras se edita. *Acceptance:* modificar un criterio actualiza el conteo en menos de 5 s sobre 1 M de contactos y 100 M de eventos.
- **FR-24** — Un segmento puede usar otros segmentos como criterio (segmentos combinados). *Acceptance:* un segmento "A menos B" devuelve el conteo de A menos la intersección con B.
- **FR-25** — Los segmentos se evalúan bajo demanda o en agenda, y cada ejecución guarda su conteo histórico. *Acceptance:* un segmento programado diario muestra un gráfico de su tamaño en los últimos 30 días.
- **FR-26** — La API lista segmentos, devuelve su conteo y los contactos que lo componen, paginados. *Acceptance:* la suma de las páginas es igual al conteo informado.

### Email (M4)

- **FR-27** — El marketer diseña emails con un editor de bloques (texto, imagen, botón, columnas, productos, HTML libre), con vista previa desktop/mobile. *Acceptance:* un email armado solo con bloques se ve correcto en la vista previa mobile y el HTML generado pasa la validación de compatibilidad del renderizador.
- **FR-28** — El contenido admite personalización con campos del contacto, datos del evento disparador, condiciones y valores por defecto. *Acceptance:* "Hola {{nombre|cliente}}" muestra el nombre, o "cliente" si falta.
- **FR-29** — Se gestionan bloques y plantillas reutilizables, e imágenes en una biblioteca de assets. *Acceptance:* editar un bloque compartido actualiza la vista previa de los emails que lo usan y aún no se enviaron.
- **FR-30** — El marketer envía emails de prueba a direcciones o a una lista semilla, con los datos de un contacto elegido. *Acceptance:* el email de prueba llega con la personalización del contacto elegido y marcado como prueba.
- **FR-31** — Una campaña de email tiene remitente, asunto, preheader, contenido, audiencia (segmento o lista) y agenda: inmediata, programada o por zona horaria del contacto. *Acceptance:* una campaña programada a las 10:00 "hora del contacto" se entrega a cada contacto a las 10:00 de su zona.
- **FR-32** — Al lanzar, se excluyen contactos sin consentimiento, suprimidos (bounce duro, queja, baja) y duplicados por email. *Acceptance:* un contacto con opt-in email = no, incluido en el segmento, no recibe el envío y figura como excluido con motivo.
- **FR-33** — Las campañas soportan test A/B de asunto o contenido sobre un porcentaje de la audiencia, con envío automático de la variante ganadora por aperturas o clicks tras un tiempo definido. *Acceptance:* con 20% de prueba y 2 h de espera, el 80% restante recibe la variante con mejor tasa.
- **FR-34** — Se registran entregas, aperturas, clicks por enlace, bounces (duro/blando), quejas y bajas por mensaje. *Acceptance:* abrir y clickear un email de prueba incrementa ambos contadores de la campaña en menos de 10 s.
- **FR-35** — Todo email incluye baja con un click (List-Unsubscribe y List-Unsubscribe-Post) y enlace a un centro de preferencias. *Acceptance:* el POST one-click cambia el opt-in email del contacto a "no" sin pedir login.
- **FR-36** — El administrador configura dominios de envío y la consola verifica sus registros SPF, DKIM y DMARC. *Acceptance:* un dominio sin DKIM válido no puede usarse como remitente y la consola muestra el registro a crear.
- **FR-37** — Se pueden enviar emails transaccionales disparados por un External Event, con los datos del payload. *Acceptance:* disparar `order_shipped` envía el email asociado con el tracking del payload en menos de 30 s.

### Automation Center (M5)

- **FR-38** — El marketer diseña programas en un editor visual de nodos: triggers, esperas, condiciones, splits y acciones. *Acceptance:* un programa guardado y reabierto conserva nodos, conexiones y configuración.
- **FR-39** — Los triggers disponibles son: entrada a un segmento, evento externo, evento de comportamiento (carrito abandonado, vista de producto, compra), cambio de campo, fecha de un campo (cumpleaños) y agenda recurrente. *Acceptance:* cada tipo de trigger tiene un programa de prueba que inscribe al contacto esperado.
- **FR-40** — Los nodos de espera admiten duración fija, hasta una fecha u hora del contacto, y "hasta que ocurra un evento o pase un máximo". *Acceptance:* "esperar hasta compra, máximo 2 días" continúa por la rama "compró" si hay compra y por la de timeout si no.
- **FR-41** — Existen splits por condición (perfil o comportamiento), por porcentaje aleatorio y por decisión de modelo (M6). *Acceptance:* un split 50/50 sobre 10.000 contactos reparte entre 48% y 52% en cada rama.
- **FR-42** — Las acciones incluyen: enviar email, SMS o push, actualizar campo, agregar/quitar de lista, disparar webhook e inscribir en otro programa. *Acceptance:* cada acción tiene un programa de prueba cuyo efecto es observable en la ficha del contacto o en el receptor del webhook.
- **FR-43** — Un programa se activa, pausa y detiene; se pueden publicar nuevas versiones sin perder a los contactos en curso. *Acceptance:* al publicar v2 con un contacto esperando en v1, ese contacto termina su recorrido en v1 y los nuevos entran en v2.
- **FR-44** — Hay reglas de reingreso (una vez, cada N días, siempre) y límite de frecuencia de mensajes por contacto a nivel tenant. *Acceptance:* con límite de 1 email/día, un contacto que califica para dos programas el mismo día recibe uno solo y el otro queda registrado como suprimido por frecuencia.
- **FR-45** — Cada nodo muestra cuántos contactos pasaron, están esperando o salieron, y el marketer puede ver el recorrido de un contacto concreto. *Acceptance:* buscar un contacto en el programa muestra los nodos por los que pasó con fecha y hora.
- **FR-46** — El programa de carrito abandonado funciona de punta a punta con los datos del sitio demo. *Acceptance:* dejar un carrito sin comprar dispara el email con los productos del carrito tras la espera configurada; comprar antes cancela el envío.

### Catálogo y Predict (M6)

- **FR-47** — Se carga el catálogo de productos (id, título, URL, imagen, precio, categoría, marca, disponibilidad, atributos) por feed CSV programado y por API de stream, incluido borrado. *Acceptance:* un producto borrado por API deja de aparecer en recomendaciones en menos de 5 minutos.
- **FR-48** — El sistema recomienda productos con lógicas: personales, relacionados a un producto, complementarios al carrito, más vendidos por categoría y vistos recientemente. *Acceptance:* en el sitio demo, cada lógica devuelve productos disponibles y distintos del producto de referencia.
- **FR-49** — Las recomendaciones se insertan en emails (bloque de productos) y en el sitio (widget), con filtros por categoría, precio o disponibilidad. *Acceptance:* un bloque "personales, categoría calzado" en un email muestra solo calzado disponible.
- **FR-50** — Se calcula para cada contacto: probabilidad de churn, valor de vida previsto, etapa de ciclo de vida y mejor horario de envío. *Acceptance:* los cuatro valores son visibles en la ficha y usables como criterio de segmento.
- **FR-51** — La campaña y el programa pueden enviar a cada contacto en su mejor horario dentro de una ventana. *Acceptance:* con la ventana de 24 h activa, los envíos se distribuyen según el horario previsto de cada contacto.
- **FR-52** — Los modelos se reentrenan en agenda y cada versión registra sus métricas; se puede volver a la versión anterior. *Acceptance:* la consola del operador lista versiones con métricas y activar una anterior cambia las predicciones servidas.
- **FR-53** — Las recomendaciones registran impresiones y clicks, y se mide el revenue atribuido a cada widget o bloque. *Acceptance:* un click en una recomendación seguido de compra suma revenue al widget.

### Canales adicionales (M7)

- **FR-54** — Se envían SMS por campaña, programa y API, con consentimiento propio, remitente configurable, conteo de segmentos de caracteres y baja por palabra clave. *Acceptance:* responder STOP cambia el opt-in SMS del contacto a "no".
- **FR-55** — Se envían notificaciones push a apps Flutter (Android/iOS) y a navegadores (Web Push), con registro de dispositivos y tracking de apertura. *Acceptance:* un push de campaña llega a la app demo y su apertura queda registrada.
- **FR-56** — Existen mensajes in-app y una bandeja de mensajes dentro de la app. *Acceptance:* un mensaje de bandeja enviado aparece en la app demo y se marca leído al abrirlo.
- **FR-57** — El marketer crea piezas web (overlay, banner, barra) con contenido, reglas de disparo (tiempo, scroll, intención de salida) y audiencia por segmento. *Acceptance:* un overlay para "compradores de los últimos 30 días" se muestra solo a esos visitantes identificados.
- **FR-58** — Se generan pases de Apple Wallet y Google Wallet (cupón, tarjeta de loyalty) personalizados y actualizables. *Acceptance:* un pase generado se agrega a la wallet y un cambio de puntos lo actualiza.
- **FR-59** — Un segmento se sincroniza como audiencia en Meta y Google Ads, con actualización periódica. *Acceptance:* con credenciales de prueba, la audiencia remota refleja altas y bajas del segmento; sin credenciales se usa un adaptador simulado.

### Reporting (M8)

- **FR-60** — Cada campaña y programa tiene un reporte con envíos, entregas, aperturas, clicks, bounces, bajas, quejas y revenue, con evolución temporal. *Acceptance:* las cifras coinciden con el conteo directo de eventos del dataset de prueba.
- **FR-61** — El revenue se atribuye a mensajes con modelo de último click y ventana configurable (por defecto 7 días), por canal. *Acceptance:* una compra 3 días después de un click suma a esa campaña; a los 8 días no suma.
- **FR-62** — Un dashboard del tenant muestra contactos contactables por canal, crecimiento de la base, engagement y revenue por canal en un rango de fechas. *Acceptance:* cambiar el rango recalcula todas las tarjetas en menos de 3 s.
- **FR-63** — Se muestra el análisis RFM de la base y la distribución por etapa de ciclo de vida, usable como segmento. *Acceptance:* hacer click en un cuadrante RFM crea un segmento con esos contactos.
- **FR-64** — Los eventos crudos del tenant se exportan de forma programada (Open Data) a archivos Parquet descargables. *Acceptance:* un export diario deja un Parquet por tipo de evento legible con DuckDB.

### Loyalty (M9)

- **FR-65** — El administrador define un programa de loyalty con niveles, reglas de acumulación de puntos (por compra, por evento) y expiración. *Acceptance:* una compra de $100 con regla 1 punto/$ suma 100 puntos al contacto.
- **FR-66** — Los contactos suben y bajan de nivel según umbrales y período de cálculo. *Acceptance:* superar el umbral mueve al contacto al nivel superior y dispara el trigger "cambio de nivel".
- **FR-67** — Se definen recompensas canjeables por puntos o asignadas por nivel, con vouchers únicos. *Acceptance:* canjear una recompensa descuenta los puntos y entrega un código no usado.
- **FR-68** — Puntos, nivel y recompensas son usables en segmentos, personalización y programas, y consultables por API y wallet. *Acceptance:* un email muestra "Te faltan {{puntos_para_siguiente_nivel}} puntos".

### IA generativa e integraciones (M10)

- **FR-69** — En el editor de email, el marketer genera y reescribe asuntos, preheaders y textos de bloques según un brief, un tono y un idioma. *Acceptance:* pedir 5 asuntos para un brief devuelve 5 opciones distintas en el idioma pedido.
- **FR-70** — El marketer genera imágenes para bloques de email a partir de un prompt y las guarda en la biblioteca de assets. *Acceptance:* la imagen generada queda en la biblioteca con el prompt como metadato.
- **FR-71** — El marketer describe un segmento en lenguaje natural y el sistema propone los criterios, que puede revisar antes de guardar. *Acceptance:* "clientes que compraron zapatillas en 90 días y no abrieron emails" produce criterios equivalentes a los armados a mano.
- **FR-72** — Cada segmento puede mostrar una descripción generada de su composición. *Acceptance:* la descripción menciona los criterios reales y el tamaño actual.
- **FR-73** — Un asistente conversacional en la consola ejecuta tareas por lenguaje natural (listar, duplicar y agendar campañas, crear borradores de programas), pidiendo confirmación antes de cualquier escritura. *Acceptance:* "duplicá la campaña de Black Friday para el sábado" crea el duplicado solo tras confirmar.
- **FR-74** — Conectores con Shopify, WooCommerce y Magento sincronizan clientes, productos y órdenes, y registran el tracking del sitio. *Acceptance:* con una tienda de desarrollo conectada, una orden nueva aparece en open-emarsys en menos de 1 minuto.
- **FR-75** — El tenant registra webhooks salientes para eventos del sistema (baja, bounce, entrada a programa), firmados con HMAC. *Acceptance:* el receptor valida la firma con el secreto del webhook y rechaza un payload alterado.

## Non-functional requirements

- **NFR-1 — Stack (restricción).** NestJS + Prisma + PostgreSQL para servicios de gestión; Go para servicios de alto volumen; Python 3.11+ para entrenamiento de modelos e IA generativa; Next.js 15 + Tailwind + shadcn/ui + next-intl para la consola; Redis, MinIO y Docker Compose. Monorepo único.
- **NFR-2 — Arquitectura (restricción).** Microservicios por dominio que separan plano de control y plano de datos; comunicación asíncrona por NATS JetStream; gRPC solo en llamadas síncronas calientes entre servicios; ClickHouse como almacén de eventos; Temporal para la ejecución durable de programas.
- **NFR-3 — Rendimiento de ingesta.** El collector sostiene 2.000 eventos/s con p99 < 50 ms de respuesta en un host de 8 vCPU/16 GB, sin pérdida de eventos aceptados.
- **NFR-4 — Rendimiento de tracking.** Pixel y redirect responden con p99 < 20 ms a 1.000 req/s.
- **NFR-5 — Rendimiento de segmentación.** Conteo de un segmento con 5 criterios mixtos < 5 s sobre 1 M de contactos y 100 M de eventos.
- **NFR-6 — Rendimiento de envío.** El dispatcher entrega 200 emails/s al MTA local, respetando límites por dominio y tenant.
- **NFR-7 — Latencia de predicción.** Recomendaciones y scores en línea con p99 < 50 ms.
- **NFR-8 — Aislamiento multi-tenant.** Ningún camino de lectura o escritura devuelve datos de otro tenant; se verifica con tests automáticos que intentan acceso cruzado en cada servicio.
- **NFR-9 — Seguridad.** API autenticada con OAuth 2.0 client credentials (JWT); contraseñas con Argon2id; secretos fuera del repo; webhooks firmados con HMAC; OWASP ASVS nivel 1 en la consola y la API pública.
- **NFR-10 — Privacidad.** Consentimiento por canal auditable; borrado GDPR completo en 30 días como máximo, incluidos almacenes de eventos y modelos derivados en el siguiente reentrenamiento.
- **NFR-11 — Durabilidad.** Reiniciar cualquier servicio no pierde contactos en programas, eventos aceptados ni envíos programados; los envíos son idempotentes (un contacto nunca recibe dos veces el mismo mensaje por un reintento).
- **NFR-12 — Observabilidad.** Todos los servicios emiten trazas, métricas y logs JSON con OpenTelemetry; un stack local de Grafana muestra latencia, throughput y errores por servicio.
- **NFR-13 — Reproducibilidad.** `docker compose up` levanta la plataforma completa con datos semilla (tienda ficticia, 100.000 contactos, 10 M de eventos) en un host limpio.
- **NFR-14 — Calidad.** Cada servicio tiene tests unitarios y de integración en CI; los contratos (eventos, gRPC, API pública) están versionados y validados en CI.
- **NFR-15 — Accesibilidad.** La consola cumple WCAG 2.2 AA en sus flujos principales.
- **NFR-16 — Internacionalización.** Consola en es/pt/en; contenidos, fechas, monedas y zonas horarias por contacto.
- **NFR-17 — Costo de IA.** Las llamadas a LLM pasan por un router con límite de gasto por tenant y proveedor de respaldo; los modelos predictivos no dependen de APIs pagas.

## Assumptions

- **A1** — La API pública replica la *forma* de la API de Emarsys (field IDs, `key_id`, lotes, jobs asíncronos, envelope `replyCode`/`replyText`/`data`) bajo `/api/v3`, con OAuth 2.0 en lugar de WSSE. Así la documentación de Emarsys sirve como spec de referencia.
- **A2** — Escala objetivo de estudio: 1 M de contactos y 100 M de eventos por tenant, en un solo host. Es lo que justifica ClickHouse y Temporal.
- **A3** — Bus de eventos: NATS JetStream. BullMQ se usa solo para colas internas de un servicio Node.
- **A4** — Motor de programas: Temporal con workers Go, en lugar de un motor propio.
- **A5** — Multi-tenant con `tenant_id` en todas las entidades, RLS en PostgreSQL y partición por tenant en ClickHouse.
- **A6** — Monorepo: pnpm + Turborepo para TypeScript, `go.work` para Go, `uv` para Python, contratos compartidos en `/proto` y `/contracts`.
- **A7** — Se arranca con pocos deployables (un `core` NestJS con módulos por dominio más los servicios Go de ingesta) y los módulos se extraen a servicios cuando escalan, fallan o usan otro lenguaje distinto.
- **A8** — En desarrollo los emails van a Mailpit; los envíos reales usan un proveedor transaccional (SES) configurable por tenant. SMS usa un adaptador simulado más uno de Twilio.
- **A9** — El sitio y la app demo (tienda ficticia) son parte del proyecto y generan los datos para validar los criterios de aceptación.
- **A10** — La IA generativa reutiliza el router LLM multi-provider existente del autor (Python); los modelos predictivos se entrenan en Python y se sirven en Go vía ONNX.
- **A11** — Los milestones M0–M10 se implementan en orden y cada uno corresponde a una fase F0–F10 de las specs.
- **A12** — La ficha del contacto de FR-10 sale en M1 sin timeline; la timeline de eventos (últimos 50) se completa en M2, que es cuando existen eventos. La aceptación de FR-10 se verifica completa al cerrar M2.
- **A13** — El límite de frecuencia de FR-44 aplica a los mensajes enviados por programas (Automation Center). Las campañas one-shot lanzadas a mano no pasan por el límite: el marketer las elige explícitamente.

## Open questions

- **Q1** — ¿Hay una cuenta de AWS SES (o similar) y un dominio propio para validar envíos reales en M4? Si no, M4 cierra con Mailpit y el FR-36 se verifica contra DNS simulado. *Responde:* Alejandro.
- **Q2** — ¿Cuentas de desarrollador de Meta Ads, Google Ads, Apple Developer (Wallet y APNs) y Twilio para M7? Sin ellas, FR-55/58/59 cierran con adaptadores simulados. *Responde:* Alejandro.
- **Q3** — ¿El repo tendrá remoto en GitHub? orch necesita un remoto para abrir PRs por tarea; hoy trabaja solo en worktrees locales. *Responde:* Alejandro.

## Milestones

- **M0 — Plataforma base:** tenants, usuarios, roles, login, credenciales de API, consola vacía navegable en 3 idiomas. FR-1, FR-2, FR-3, FR-4, FR-5, FR-6
- **M1 — Base de contactos:** campos con field IDs, API de contactos compatible en forma, import/export, listas, consentimiento, GDPR, datos relacionales. FR-7 a FR-16
- **M2 — Comportamiento en vivo:** script de tracking en el sitio demo, identificación, External Events, órdenes, timeline del contacto. FR-17 a FR-21
- **M3 — Segmentación:** builder de perfil y comportamiento con conteo en vivo, segmentos combinados e históricos. FR-22 a FR-26
- **M4 — Email de punta a punta:** editor, personalización, campañas, A/B, envío, tracking, bajas, dominios, transaccionales. FR-27 a FR-37
- **M5 — Automation Center:** editor de programas, triggers, esperas, splits, acciones, versionado, carrito abandonado. FR-38 a FR-46
- **M6 — Catálogo y Predict:** catálogo, recomendaciones en email y web, churn/CLV/ciclo de vida, send time optimization, versionado de modelos. FR-47 a FR-53
- **M7 — Omnicanal:** SMS, push y bandeja, piezas web, wallet, audiencias de Ads. FR-54 a FR-59
- **M8 — Reporting:** reportes por campaña y programa, atribución, dashboard, RFM, Open Data. FR-60 a FR-64
- **M9 — Loyalty:** niveles, puntos, recompensas, integración con segmentos y wallet. FR-65 a FR-68
- **M10 — IA generativa e integraciones:** generación de contenido e imágenes, segmentos por lenguaje natural, asistente, conectores de e-commerce, webhooks. FR-69 a FR-75
