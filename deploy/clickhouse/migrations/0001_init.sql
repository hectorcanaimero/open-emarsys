-- Tabla de control de migraciones aplicadas por deploy/clickhouse/migrate.sh.
-- No crear nada más aquí: cada migración siguiente se registra a sí misma.
CREATE TABLE IF NOT EXISTS oe.schema_migrations (
    version String,
    applied_at DateTime DEFAULT now()
) ENGINE = MergeTree
ORDER BY version;
