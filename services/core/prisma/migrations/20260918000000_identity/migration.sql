-- The schemas already exist, owned by `core` (deploy/postgres/init/00-roles.sql), and
-- `core` has no CREATE on the database, so Prisma's CREATE SCHEMA statements are dropped.

-- UUID v7 (RFC 9562): 48-bit Unix ms timestamp over a v4 UUID, version bits set to 0111.
-- Postgres 17 has no built-in uuidv7().
CREATE FUNCTION "identity"."uuid_v7"() RETURNS uuid LANGUAGE sql VOLATILE AS $$
  SELECT encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid())
        placing substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
        FROM 1 FOR 6),
      52, 1), 53, 1),
    'hex')::uuid
$$;

-- CreateEnum
CREATE TYPE "identity"."tenant_status" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "identity"."locale" AS ENUM ('es', 'pt', 'en');

-- CreateEnum
CREATE TYPE "identity"."user_status" AS ENUM ('invited', 'active', 'disabled');

-- CreateEnum
CREATE TYPE "identity"."permission_action" AS ENUM ('view', 'edit', 'launch', 'admin');

-- CreateEnum
CREATE TYPE "identity"."actor_type" AS ENUM ('user', 'client', 'service');

-- CreateTable
CREATE TABLE "identity"."tenants" (
    "id" UUID NOT NULL DEFAULT identity.uuid_v7(),
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "default_locale" "identity"."locale" NOT NULL DEFAULT 'es',
    "limits" JSONB NOT NULL DEFAULT '{}',
    "status" "identity"."tenant_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."users" (
    "id" UUID NOT NULL DEFAULT identity.uuid_v7(),
    "tenant_id" UUID,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "password_hash" TEXT,
    "mfa_secret" TEXT,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "locale" "identity"."locale" NOT NULL DEFAULT 'es',
    "status" "identity"."user_status" NOT NULL DEFAULT 'active',
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."roles" (
    "id" UUID NOT NULL DEFAULT identity.uuid_v7(),
    "tenant_id" UUID,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."role_permissions" (
    "role_id" UUID NOT NULL,
    "tenant_id" UUID,
    "module" TEXT NOT NULL,
    "action" "identity"."permission_action" NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","module","action")
);

-- CreateTable
CREATE TABLE "identity"."user_roles" (
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "tenant_id" UUID,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "identity"."api_clients" (
    "id" UUID NOT NULL DEFAULT identity.uuid_v7(),
    "tenant_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "revoked_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."refresh_tokens" (
    "id" UUID NOT NULL DEFAULT identity.uuid_v7(),
    "tenant_id" UUID,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "rotated_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."invitations" (
    "id" UUID NOT NULL DEFAULT identity.uuid_v7(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "role_ids" UUID[],
    "invited_by" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."mfa_recovery_codes" (
    "id" UUID NOT NULL DEFAULT identity.uuid_v7(),
    "tenant_id" UUID,
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."audit_log" (
    "id" UUID NOT NULL DEFAULT identity.uuid_v7(),
    "tenant_id" UUID,
    "actor_type" "identity"."actor_type" NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "diff" JSONB,
    "ip" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_name_key" ON "identity"."roles"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "user_roles_role_id_idx" ON "identity"."user_roles"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_clients_client_id_key" ON "identity"."api_clients"("client_id");

-- CreateIndex
CREATE INDEX "api_clients_tenant_id_idx" ON "identity"."api_clients"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "identity"."refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "identity"."refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "identity"."refresh_tokens"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "identity"."invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_tenant_id_idx" ON "identity"."invitations"("tenant_id");

-- CreateIndex
CREATE INDEX "mfa_recovery_codes_user_id_idx" ON "identity"."mfa_recovery_codes"("user_id");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_at_idx" ON "identity"."audit_log"("tenant_id", "at" DESC);

-- AddForeignKey
ALTER TABLE "identity"."users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."roles" ADD CONSTRAINT "roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "identity"."roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."role_permissions" ADD CONSTRAINT "role_permissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "identity"."roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."user_roles" ADD CONSTRAINT "user_roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."api_clients" ADD CONSTRAINT "api_clients_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."invitations" ADD CONSTRAINT "invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."invitations" ADD CONSTRAINT "invitations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------
-- Hand-written: what Prisma cannot express (NFR-8, FR-6).
-- ---------------------------------------------------------------------------------------

-- One email per tenant, case-insensitive. NULLS NOT DISTINCT makes it hold for platform
-- operators too (tenant_id null).
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "identity"."users" ("tenant_id", lower("email")) NULLS NOT DISTINCT;

-- Row level security. `core` owns these tables, so FORCE makes RLS apply to it as well.
-- A row is visible only when its tenant is the one set by @oe/ts-common/prisma-tenant
-- (`set_config('app.tenant_id', ..., true)`). Rows with tenant_id null (the platform
-- operator) and lookups that happen before the tenant is known (login by email, refresh,
-- invitation acceptance) need a role with BYPASSRLS through withSystemScope. nullif():
-- once set in a session the setting reads '' instead of null, and ''::uuid would throw.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'roles', 'role_permissions', 'user_roles', 'api_clients',
                           'refresh_tokens', 'invitations', 'mfa_recovery_codes', 'audit_log'] LOOP
    EXECUTE format('ALTER TABLE identity.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE identity.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON identity.%I
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- A tenant sees only its own tenant row.
ALTER TABLE "identity"."tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "identity"."tenants" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "identity"."tenants"
  USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- audit_log is append-only for the service role.
REVOKE UPDATE, DELETE, TRUNCATE ON "identity"."audit_log" FROM core;
