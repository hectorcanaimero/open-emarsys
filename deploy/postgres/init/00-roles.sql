-- Roles y schemas por servicio (NFR-8): un rol por servicio del arch, cada uno
-- dueño solo de su(s) propio(s) schema(s) y sin BYPASSRLS. Los passwords se leen
-- de variables de entorno del contenedor (ver deploy/compose/.env.example) con
-- \getenv, ya que este archivo lo ejecuta psql vía docker-entrypoint-initdb.d.

\getenv core_password OE_PG_CORE_PASSWORD
\getenv importer_password OE_PG_IMPORTER_PASSWORD
\getenv segments_password OE_PG_SEGMENTS_PASSWORD
\getenv content_password OE_PG_CONTENT_PASSWORD
\getenv campaigns_password OE_PG_CAMPAIGNS_PASSWORD
\getenv dispatcher_password OE_PG_DISPATCHER_PASSWORD
\getenv automation_password OE_PG_AUTOMATION_PASSWORD
\getenv ml_password OE_PG_ML_PASSWORD
\getenv analytics_password OE_PG_ANALYTICS_PASSWORD
\getenv loyalty_password OE_PG_LOYALTY_PASSWORD
\getenv connectors_password OE_PG_CONNECTORS_PASSWORD
\getenv temporal_password OE_PG_TEMPORAL_PASSWORD

CREATE ROLE core       LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'core_password';
CREATE ROLE importer   LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'importer_password';
CREATE ROLE segments   LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'segments_password';
CREATE ROLE content    LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'content_password';
CREATE ROLE campaigns  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'campaigns_password';
CREATE ROLE dispatcher LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'dispatcher_password';
CREATE ROLE automation LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'automation_password';
CREATE ROLE ml         LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'ml_password';
CREATE ROLE analytics  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'analytics_password';
CREATE ROLE loyalty    LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'loyalty_password';
CREATE ROLE connectors LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'connectors_password';
CREATE ROLE temporal   LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'temporal_password';

-- Rol sin login que `core` asume vía `SET LOCAL ROLE` (@oe/ts-common/prisma-tenant
-- withSystemScope, F0.6.T3): filas sin tenant (el operador de plataforma, o tenants
-- antes de existir) nunca calzan con la política tenant_isolation, así que el módulo de
-- tenants necesita un rol BYPASSRLS explícito para leerlas y escribirlas. `WITH INHERIT
-- FALSE` (PG16+) is required: a plain membership would make `core` automatically inherit
-- core_system's table grants at all times, silently undoing the audit_log UPDATE/DELETE
-- revoke below. `core` only gets those privileges by explicitly switching role.
CREATE ROLE core_system NOLOGIN BYPASSRLS;
GRANT core_system TO core WITH INHERIT FALSE;

-- Schemas del rol core: identity, contacts, events_registry, catalog, devices, inbox.
CREATE SCHEMA IF NOT EXISTS identity        AUTHORIZATION core;
CREATE SCHEMA IF NOT EXISTS contacts        AUTHORIZATION core;
CREATE SCHEMA IF NOT EXISTS events_registry AUTHORIZATION core;
CREATE SCHEMA IF NOT EXISTS catalog         AUTHORIZATION core;
CREATE SCHEMA IF NOT EXISTS devices         AUTHORIZATION core;
CREATE SCHEMA IF NOT EXISTS inbox           AUTHORIZATION core;
ALTER ROLE core SET search_path = identity, contacts, events_registry, catalog, devices, inbox;

-- Trigram indexes for contact search (F1.2.T1). `core` cannot create extensions (no CREATE
-- on the database), so the superuser does it here; the migration references
-- `public.gin_trgm_ops`. A database created before this line needs it run once by hand.
CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public;

-- BYPASSRLS alone skips policies, not the ordinary schema/table grants: `core_system` still
-- needs privileges of its own on the tables `core`'s migrations create (SET ROLE does not
-- inherit them). Scoped to `identity`, the only schema the tenants module touches.
GRANT USAGE ON SCHEMA identity TO core_system;
ALTER DEFAULT PRIVILEGES FOR ROLE core IN SCHEMA identity
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO core_system;

-- Un schema homónimo por cada uno de los demás roles/servicios.
CREATE SCHEMA IF NOT EXISTS importer   AUTHORIZATION importer;
CREATE SCHEMA IF NOT EXISTS segments   AUTHORIZATION segments;
CREATE SCHEMA IF NOT EXISTS content    AUTHORIZATION content;
CREATE SCHEMA IF NOT EXISTS campaigns  AUTHORIZATION campaigns;
CREATE SCHEMA IF NOT EXISTS dispatcher AUTHORIZATION dispatcher;
CREATE SCHEMA IF NOT EXISTS automation AUTHORIZATION automation;
CREATE SCHEMA IF NOT EXISTS ml         AUTHORIZATION ml;
CREATE SCHEMA IF NOT EXISTS analytics  AUTHORIZATION analytics;
CREATE SCHEMA IF NOT EXISTS loyalty    AUTHORIZATION loyalty;
CREATE SCHEMA IF NOT EXISTS connectors AUTHORIZATION connectors;
CREATE SCHEMA IF NOT EXISTS temporal   AUTHORIZATION temporal;

ALTER ROLE importer   SET search_path = importer;
ALTER ROLE segments   SET search_path = segments;
ALTER ROLE content    SET search_path = content;
ALTER ROLE campaigns  SET search_path = campaigns;
ALTER ROLE dispatcher SET search_path = dispatcher;
ALTER ROLE automation SET search_path = automation;
ALTER ROLE ml         SET search_path = ml;
ALTER ROLE analytics  SET search_path = analytics;
ALTER ROLE loyalty    SET search_path = loyalty;
ALTER ROLE connectors SET search_path = connectors;
ALTER ROLE temporal   SET search_path = temporal;

-- CREATE SCHEMA ... AUTHORIZATION <role> ya deja al schema sin privilegios para
-- ningún otro rol (ni siquiera PUBLIC): ningún rol puede leer un schema ajeno.
