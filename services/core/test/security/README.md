# Suite de seguridad de core

`pnpm --filter @oe/core test:security` levanta la app completa (`AppModule.forRoot`) contra
Postgres (con migraciones y los roles de `deploy/postgres/init/00-roles.sql`) y NATS
(JetStream con los streams de `deploy/nats/streams/`) en testcontainers. Crea dos tenants por
la API como operador. El admin de B crea sus propios recursos, y A intenta atacarlos. También
corre dentro de `pnpm test`.

## Qué cubre

| Bloque | Qué verifica |
|---|---|
| Inventario | Las rutas se **descubren** de los controladores registrados (Nest `DiscoveryService`) junto con su metadata `@Public`, `@InternalOnly`, `@RequirePermission` y `OperatorOnlyGuard`. |
| Autenticación (D7) | Cada ruta sin `@Public` responde 401 sin token, con token expirado y con token firmado por otra llave. Un token `typ=service` recibe 403 fuera de `/internal`, y un token de usuario recibe 403 en `/internal`. |
| Permisos (FR-2) | Cada ruta con `@RequirePermission` responde 403 a un principal que tiene todos los permisos menos ese. Como control, ese principal con todos los permisos no recibe 401/403. |
| Acceso cruzado (NFR-8) | El admin de A, con todos los permisos, ataca por ID los recursos de B. Debe recibir 403 o 404, la respuesta no puede contener datos de B y el recurso de B debe quedar intacto. Ningún `GET` de lista de `/admin/v1` le muestra nada de B, y A no puede asignar ni invitar con roles de B. |
| Auditoría (FR-6) | Las acciones del operador (`tenant_id` null) quedan en `audit_log` a pesar de RLS. |
| Errores | Un 500 real (se le quita `SELECT` a `core`) responde `problem+json` sin stack trace, rutas de código ni SQL. |

## Cómo agregar rutas en fases siguientes

La mayor parte es automática. Basta con registrar el módulo en `src/app.module.ts`:

- **Autenticación y permisos**: no requieren nada. Toda ruta nueva entra en la matriz por su
  metadata. El control usa IDs aleatorios y body `{}`, así que la ruta debe responder 400/404
  (y no 401/403) cuando tiene todos los permisos.
- **`@Public()` nuevo**: agregarlo a `PUBLIC_ROUTES` en `security.spec.ts`. Si no está en la
  lista, la suite falla. Hacer pública una ruta es una decisión de seguridad y debe verse en
  el diff.
- **Ruta de `/admin/v1` con parámetro de path** (`:id`, …): agregar una entrada a
  `CROSS_TENANT` con la clave `"MÉTODO /ruta/:param"`. La entrada construye la URL contra un
  recurso de B, agregando el fixture a `Fixtures` y creándolo en `beforeAll` como admin de B
  por la API cuando se pueda. También define un `unchanged()` que verifica con `su` (el
  superusuario, que salta RLS) que el recurso de B no cambió. Si falta la entrada, la suite
  falla.
- **Strings de B** que no deban aparecer nunca en respuestas a A: agregarlos a `B_SECRETS`.
- **Rutas `/api/v3` y `/internal/v1`**: la autenticación y los permisos ya las cubren. Si
  reciben IDs de otro tenant, sumar un caso explícito como el de `role_ids`.

## Verificación de que la suite detecta la falta de RLS

Hecha a mano el 2026-09-18, agregando temporalmente en `beforeAll`, justo después de crear
`su`, una sentencia que desactiva la protección de `identity.users`:

- `ALTER POLICY tenant_isolation ON identity.users USING (true)`: fallan 2 tests. A puede
  hacer `PATCH /admin/v1/users/{id de B}` (200, nombre y estado cambiados), puede hacer
  `DELETE` (204), y `GET /admin/v1/users` le lista usuarios de B.
- `ALTER TABLE identity.users DISABLE ROW LEVEL SECURITY`: fallan los mismos 2 tests.

Sin la sentencia, los 11 tests pasan.
