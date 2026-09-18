-- The `contacts` schema already exists, owned by `core` (deploy/postgres/init/00-roles.sql).
-- pg_trgm is created there as well, by the superuser: `core` has no CREATE on the database,
-- so this statement only succeeds (as a no-op) once the extension is already installed.
CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public;

-- CreateEnum
CREATE TYPE "contacts"."field_type" AS ENUM ('text', 'number', 'date', 'boolean', 'single_choice', 'multi_choice');

-- CreateEnum
CREATE TYPE "contacts"."consent_channel" AS ENUM ('email', 'sms', 'push');

-- CreateEnum
CREATE TYPE "contacts"."gdpr_request_kind" AS ENUM ('export', 'forget');

-- CreateEnum
CREATE TYPE "contacts"."gdpr_request_status" AS ENUM ('pending', 'running', 'done', 'failed');

-- CreateTable
CREATE TABLE "contacts"."field_definitions" (
    "tenant_id" UUID NOT NULL,
    "field_id" INTEGER NOT NULL,
    "api_name" TEXT NOT NULL,
    "labels" JSONB NOT NULL,
    "type" "contacts"."field_type" NOT NULL,
    "choices" JSONB NOT NULL DEFAULT '[]',
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "unique" BOOLEAN NOT NULL DEFAULT false,
    "read_only" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "field_definitions_pkey" PRIMARY KEY ("tenant_id","field_id")
);

-- CreateTable
CREATE TABLE "contacts"."field_id_counters" (
    "tenant_id" UUID NOT NULL,
    "last_id" INTEGER NOT NULL,

    CONSTRAINT "field_id_counters_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable (email_norm and external_id are generated: hand-written)
CREATE TABLE "contacts"."contacts" (
    "id" UUID NOT NULL DEFAULT identity.uuid_v7(),
    "tenant_id" UUID NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "email_norm" TEXT GENERATED ALWAYS AS (nullif(lower(trim("data"->>'3')), '')) STORED,
    "external_id" TEXT GENERATED ALWAYS AS (nullif(trim("data"->>'4'), '')) STORED,
    "version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts"."unique_values" (
    "tenant_id" UUID NOT NULL,
    "field_id" INTEGER NOT NULL,
    "value" TEXT NOT NULL,
    "contact_id" UUID NOT NULL,

    CONSTRAINT "unique_values_pkey" PRIMARY KEY ("tenant_id","field_id","value")
);

-- CreateTable
CREATE TABLE "contacts"."lists" (
    "id" UUID NOT NULL DEFAULT identity.uuid_v7(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts"."list_members" (
    "list_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "list_members_pkey" PRIMARY KEY ("list_id","contact_id")
);

-- CreateTable
CREATE TABLE "contacts"."consents" (
    "id" UUID NOT NULL DEFAULT identity.uuid_v7(),
    "tenant_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "channel" "contacts"."consent_channel" NOT NULL,
    "value" SMALLINT,
    "source" TEXT NOT NULL,
    "text" TEXT,
    "actor" TEXT,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts"."gdpr_requests" (
    "id" UUID NOT NULL DEFAULT identity.uuid_v7(),
    "tenant_id" UUID NOT NULL,
    "contact_id" UUID,
    "subject_hash" TEXT,
    "kind" "contacts"."gdpr_request_kind" NOT NULL,
    "status" "contacts"."gdpr_request_status" NOT NULL DEFAULT 'pending',
    "requested_by" TEXT,
    "result_key" TEXT,
    "error" TEXT,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "gdpr_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts"."identity_links" (
    "tenant_id" UUID NOT NULL,
    "anonymous_id" TEXT NOT NULL,
    "contact_id" UUID NOT NULL,
    "linked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_links_pkey" PRIMARY KEY ("tenant_id","anonymous_id")
);

-- CreateIndex
CREATE INDEX "contacts_tenant_id_updated_at_id_idx" ON "contacts"."contacts"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE INDEX "unique_values_contact_id_idx" ON "contacts"."unique_values"("contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "lists_tenant_id_name_key" ON "contacts"."lists"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "list_members_contact_id_idx" ON "contacts"."list_members"("contact_id");

-- CreateIndex
CREATE INDEX "consents_contact_id_channel_changed_at_idx" ON "contacts"."consents"("contact_id", "channel", "changed_at" DESC);

-- CreateIndex
CREATE INDEX "gdpr_requests_tenant_id_requested_at_idx" ON "contacts"."gdpr_requests"("tenant_id", "requested_at" DESC);

-- CreateIndex
CREATE INDEX "identity_links_contact_id_idx" ON "contacts"."identity_links"("contact_id");

-- AddForeignKey
ALTER TABLE "contacts"."unique_values" ADD CONSTRAINT "unique_values_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"."contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts"."list_members" ADD CONSTRAINT "list_members_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "contacts"."lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts"."list_members" ADD CONSTRAINT "list_members_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"."contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts"."identity_links" ADD CONSTRAINT "identity_links_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"."contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------
-- Hand-written: what Prisma cannot express (FR-7, FR-13, FR-14, FR-15, NFR-8).
-- ---------------------------------------------------------------------------------------

-- `api_name` is unique per tenant among live definitions; a deleted custom field frees it.
CREATE UNIQUE INDEX "field_definitions_tenant_id_api_name_key" ON "contacts"."field_definitions" ("tenant_id", "api_name")
  WHERE "deleted_at" IS NULL;

-- Key fields 3 (email) and 4 (external_id) are unique per tenant among live contacts.
CREATE UNIQUE INDEX "contacts_tenant_id_email_norm_key" ON "contacts"."contacts" ("tenant_id", "email_norm")
  WHERE "deleted_at" IS NULL AND "email_norm" IS NOT NULL;
CREATE UNIQUE INDEX "contacts_tenant_id_external_id_key" ON "contacts"."contacts" ("tenant_id", "external_id")
  WHERE "deleted_at" IS NULL AND "external_id" IS NOT NULL;

-- Containment queries on field values (`data @> '{"7": 2}'`).
CREATE INDEX "contacts_data_idx" ON "contacts"."contacts" USING gin ("data" jsonb_path_ops);

-- Search by email prefix, first name and last name (LIKE/ILIKE, F1.2.T4).
CREATE INDEX "contacts_email_norm_trgm_idx" ON "contacts"."contacts" USING gin ("email_norm" public.gin_trgm_ops);
CREATE INDEX "contacts_first_name_trgm_idx" ON "contacts"."contacts" USING gin (("data"->>'1') public.gin_trgm_ops);
CREATE INDEX "contacts_last_name_trgm_idx" ON "contacts"."contacts" USING gin (("data"->>'2') public.gin_trgm_ops);

-- Per-tenant sequence of custom field IDs: 1000, 1001, ... Never reused, since deleted
-- definitions keep their row. The upsert locks the tenant's counter row, so concurrent
-- callers get distinct IDs. SECURITY INVOKER: RLS limits it to the caller's own tenant.
CREATE FUNCTION "contacts"."next_custom_field_id"(tenant uuid) RETURNS integer LANGUAGE sql VOLATILE AS $$
  INSERT INTO contacts.field_id_counters AS c (tenant_id, last_id) VALUES (tenant, 1000)
  ON CONFLICT (tenant_id) DO UPDATE SET last_id = c.last_id + 1
  RETURNING last_id
$$;

-- Row level security, same policy as identity: a row is visible only when its tenant is the
-- one set by @oe/ts-common/prisma-tenant. FORCE makes it apply to `core`, the owner.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['field_definitions', 'field_id_counters', 'contacts', 'unique_values', 'lists',
                           'list_members', 'consents', 'gdpr_requests', 'identity_links'] LOOP
    EXECUTE format('ALTER TABLE contacts.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE contacts.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON contacts.%I
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- consents is append-only for the service role (FR-14). The one exception is GDPR forget
-- (FR-15), which anonymizes `text` while keeping date and value as legal proof: only the
-- `core_system` role (withSystemScope) may do that, and only on that column.
REVOKE UPDATE, DELETE, TRUNCATE ON "contacts"."consents" FROM core;
GRANT USAGE ON SCHEMA "contacts" TO core_system;
GRANT SELECT, UPDATE ("text") ON "contacts"."consents" TO core_system;
