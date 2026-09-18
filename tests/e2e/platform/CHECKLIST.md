# Cierre de F0 — checklist

Gate F0.8.T1, ejecutado el 2026-09-18 en un worktree limpio de `main`, con `make up && make seed && make e2e`.

| Requisito | Cómo se prueba | Resultado |
|---|---|---|
| FR-1 Tenants | e2e 3 (`tenant.spec.ts`): el operador crea un tenant con su admin, y ese admin no ve nada del tenant demo | ✅ |
| FR-2 Invitaciones y roles | e2e 4 (`invite.spec.ts`): invitación por email (enlace leído de Mailpit), rol Viewer y 403 al crear un rol | ✅ |
| FR-3 Login, MFA y bloqueo | e2e 1 y 2 (`auth.spec.ts`): contraseña incorrecta, bloqueo en el 5.º fallo (423) y MFA con TOTP | ✅ |
| FR-4 Credenciales de API | e2e 5 (`api-client.spec.ts`): el token de client credentials accede solo a su permiso y deja de funcionar al revocarlo | ✅ |
| FR-5 Idiomas | e2e 6 (`locale.spec.ts`): es, pt y en | ✅ |
| FR-6 Auditoría | e2e 7 (`audit.spec.ts`): borrar un usuario aparece en el log | ✅ |
| NFR-8 Aislamiento multi-tenant | `pnpm --filter @oe/core test:security` (11 tests: acceso cruzado por id, en listados y al asignar roles; tokens caducados o falsificados; 403 por permiso) y e2e 3 | ✅ 11/11 |
| NFR-12 Observabilidad | Tempo (datasource de Grafana) recibe trazas de `core` y `admin-web` (`/api/v2/search/tag/resource.service.name/values`) | ✅ |
| NFR-13 Reproducibilidad (parcial) | `make up` desde cero en este host: descarga de imágenes y build de core y admin-web en ~5,5 min; la plataforma sana en ~6 min | ✅ < 10 min (el seed de 100.000 contactos y 10 M de eventos llega en fases posteriores) |
| NFR-15 Accesibilidad | e2e 8 (`a11y.spec.ts`): axe sin violaciones serias en el login y las pantallas de la consola | ✅ |

## Defectos de integración corregidos en el gate

Ninguno se veía en los tests unitarios de cada tarea; solo al levantar la plataforma entera.

- `make up` no creaba `deploy/compose/.env`, no activaba los perfiles `core,data,obs` y exigía generar los secretos de core a mano → `scripts/dev-secrets.sh` (solo para desarrollo, idempotente, respeta los valores ya puestos) y `scripts/wait-healthy.sh` (servicios sanos y contenedores `*-init`/`*-migrate` terminados con 0; `docker compose up --wait` trata como fallo a un init que termina bien).
- Imágenes inexistentes: `temporalio/admin-tools:1.24.2` → `1.24.2-tctl-1.18.1-cli-1.0.0`; MinIO ya no publica en Docker Hub → `quay.io/minio/*`.
- Healthchecks rotos: Temporal escucha en la IP del contenedor y no en `127.0.0.1` (se usa `tctl cluster health`); el colector de OTel es distroless (sin healthcheck); admin-web escuchaba en `$HOSTNAME` (`HOSTNAME=0.0.0.0`) y `localhost` resolvía a IPv6 (se usa `127.0.0.1`).
- Grafana y admin-web publicaban los dos el puerto 3000 del host → admin-web pasa al 3002.
- Nadie aplicaba las migraciones de core → servicio `core-migrate` (misma imagen), del que core depende.
- La imagen de admin-web no llevaba `messages/`, que se lee en tiempo de ejecución: todas las páginas daban 500.
- Traefik rechazaba toda la configuración dinámica: `average: 0.17` en un rate limit, que tiene que ser entero (ahora `10` por `1m`), y un campo `methods` que no existe (va en la regla como `Method(...)`).
- El dashboard de Traefik, en el entrypoint `web` con `PathPrefix(/api)`, se tragaba las rutas `/api/*` de la consola (login incluido) → entrypoint propio en el 8081, sigue protegido.
- Las pantallas de usuarios, roles, auditoría, credenciales y tenants llamaban a `/admin/v1` desde el navegador sin credenciales: la sesión vive en una cookie `httpOnly` y core solo acepta Bearer → proxy BFF en admin-web (`/api/admin/[...path]`), con CSRF de doble envío en los métodos que modifican.
- core y admin-web no enviaban trazas: `OTEL_EXPORTER_OTLP_ENDPOINT` hacia el colector, e instrumentación de admin-web con `@vercel/otel`.
- Contraste insuficiente de la etiqueta de rol por defecto (WCAG AA).
- Tests e2e que no cuadraban con la plataforma: alertas que coincidían con el anunciador de rutas de Next, un permiso inexistente (`api_clients:view`), el bloqueo contado con un intento de más, un botón encontrado por subcadena ("Desactivar MFA" contiene "activar MFA") y un Viewer listando roles sin tener permiso sobre `identity`.

## Nota de este host

El puerto 8080 lo ocupa otro proceso (Tailscale), así que el `.env` local lleva `OE_TRAEFIK_PORT=18080` y `E2E_BASE_URL=http://localhost:18080`. En un host sin ese conflicto no hace falta.
