-- CreateTable
CREATE TABLE "contacts"."relational_tables" (
    "id" UUID NOT NULL DEFAULT identity.uuid_v7(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key_field" TEXT NOT NULL,
    "columns" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "relational_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts"."relational_rows" (
    "table_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "data" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "relational_rows_pkey" PRIMARY KEY ("table_id","contact_id","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "relational_tables_tenant_id_name_key" ON "contacts"."relational_tables"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "relational_rows_contact_id_idx" ON "contacts"."relational_rows"("contact_id");

-- AddForeignKey
ALTER TABLE "contacts"."relational_rows" ADD CONSTRAINT "relational_rows_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "contacts"."relational_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- GIN over the row values, for "rows where column = value" lookups.
CREATE INDEX "relational_rows_data_idx" ON "contacts"."relational_rows" USING gin ("data" jsonb_path_ops);

-- Row level security, same policy as the rest of `contacts`.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['relational_tables', 'relational_rows'] LOOP
    EXECUTE format('ALTER TABLE contacts.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE contacts.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON contacts.%I
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
