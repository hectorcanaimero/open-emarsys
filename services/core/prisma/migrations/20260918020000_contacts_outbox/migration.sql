-- CreateTable
CREATE TABLE "contacts"."outbox" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------------------
-- Hand-written: RLS like the rest of the schema, and the relay's cross-tenant access.
-- ---------------------------------------------------------------------------------------

ALTER TABLE "contacts"."outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contacts"."outbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "contacts"."outbox"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- The relay drains every tenant's rows as core_system (BYPASSRLS); FOR UPDATE needs UPDATE.
GRANT SELECT, UPDATE, DELETE ON "contacts"."outbox" TO core_system;
