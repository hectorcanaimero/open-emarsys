// Package pg wraps a pgxpool.Pool with OTel tracing and tenant-scoped
// transactions: InTenantTx sets the Postgres session variable that
// row-level-security policies key on, InSystemTx runs without it for
// platform jobs that operate across tenants.
package pg

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/open-emarsys/oe/libs/go/oe/tenant"
)

// ErrNoTenant is returned by InTenantTx when ctx carries no tenant.
var ErrNoTenant = errors.New("pg: no tenant in context")

// NewPool opens a pgxpool.Pool against dsn with an OTel query tracer
// installed, so every query and transaction is exported as a span.
func NewPool(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("pg: parse config: %w", err)
	}
	cfg.ConnConfig.Tracer = otelTracer{}

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("pg: connect: %w", err)
	}
	return pool, nil
}

// InTenantTx opens a transaction, scopes it to the tenant carried by ctx
// via set_config('app.tenant_id', ..., true) (the transaction-local
// equivalent of SET LOCAL, so row-level-security policies keyed on
// current_setting('app.tenant_id') only see that tenant's rows), then
// calls fn. It returns ErrNoTenant without opening a transaction if ctx
// carries no tenant.
func InTenantTx(ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) error) error {
	id, ok := tenant.TenantFrom(ctx)
	if !ok {
		return ErrNoTenant
	}
	return inTx(ctx, pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, id.String()); err != nil {
			return fmt.Errorf("pg: set tenant: %w", err)
		}
		return fn(tx)
	})
}

// InSystemTx opens a plain transaction with no tenant scoping, for
// platform jobs that legitimately operate across tenants.
func InSystemTx(ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) error) error {
	return inTx(ctx, pool, fn)
}

func inTx(ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) error) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("pg: begin: %w", err)
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback(ctx)
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("pg: commit: %w", err)
	}
	return nil
}
