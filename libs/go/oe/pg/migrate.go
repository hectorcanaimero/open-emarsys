package pg

import (
	"context"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Migrate applies every "*.sql" file at the root of migrations, in
// filename order, to schema. Applied versions (the filename without its
// ".sql" extension) are recorded in schema.schema_migrations, created if
// missing, so re-running Migrate only applies new files. Each migration
// runs in its own InSystemTx.
func Migrate(ctx context.Context, pool *pgxpool.Pool, schema string, migrations fs.FS) error {
	ident := pgx.Identifier{schema}.Sanitize()

	if err := InSystemTx(ctx, pool, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, fmt.Sprintf(`
			CREATE SCHEMA IF NOT EXISTS %[1]s;
			CREATE TABLE IF NOT EXISTS %[1]s.schema_migrations (
				version    text PRIMARY KEY,
				applied_at timestamptz NOT NULL DEFAULT now()
			)`, ident))
		return err
	}); err != nil {
		return fmt.Errorf("pg: ensure migrations table for schema %s: %w", schema, err)
	}

	files, err := fs.Glob(migrations, "*.sql")
	if err != nil {
		return fmt.Errorf("pg: list migrations: %w", err)
	}
	sort.Strings(files)

	for _, name := range files {
		version := strings.TrimSuffix(path.Base(name), ".sql")
		err := InSystemTx(ctx, pool, func(tx pgx.Tx) error {
			var applied bool
			if err := tx.QueryRow(ctx, fmt.Sprintf(
				`SELECT EXISTS (SELECT 1 FROM %s.schema_migrations WHERE version = $1)`, ident,
			), version).Scan(&applied); err != nil {
				return fmt.Errorf("check applied: %w", err)
			}
			if applied {
				return nil
			}

			sqlBytes, err := fs.ReadFile(migrations, name)
			if err != nil {
				return fmt.Errorf("read: %w", err)
			}
			if _, err := tx.Exec(ctx, string(sqlBytes)); err != nil {
				return fmt.Errorf("exec: %w", err)
			}
			if _, err := tx.Exec(ctx, fmt.Sprintf(
				`INSERT INTO %s.schema_migrations (version) VALUES ($1)`, ident,
			), version); err != nil {
				return fmt.Errorf("record: %w", err)
			}
			return nil
		})
		if err != nil {
			return fmt.Errorf("pg: migration %s: %w", version, err)
		}
	}
	return nil
}
