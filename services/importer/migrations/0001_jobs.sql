-- importer.jobs: queue and history of import/export jobs.
-- RLS: tenant handlers run inside pg.InTenantTx (app.tenant_id); the worker queue runs
-- inside a system tx that sets app.system = 'on' (see internal/jobs/store.go).
CREATE TABLE IF NOT EXISTS importer.jobs (
    id               uuid        PRIMARY KEY,
    tenant_id        uuid        NOT NULL,
    kind             text        NOT NULL,
    status           text        NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    params           jsonb       NOT NULL DEFAULT '{}',
    progress         jsonb       NOT NULL DEFAULT '{}',
    result_url       text,
    error_report_url text,
    error            text,
    attempts         int         NOT NULL DEFAULT 0,
    heartbeat_at     timestamptz,
    created_by       text        NOT NULL DEFAULT '',
    created_at       timestamptz NOT NULL DEFAULT now(),
    finished_at      timestamptz
);

CREATE INDEX IF NOT EXISTS jobs_queue_idx ON importer.jobs (created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS jobs_tenant_idx ON importer.jobs (tenant_id, created_at DESC, id DESC);

ALTER TABLE importer.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE importer.jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY jobs_tenant ON importer.jobs
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY jobs_system ON importer.jobs
    USING (current_setting('app.system', true) = 'on')
    WITH CHECK (current_setting('app.system', true) = 'on');
