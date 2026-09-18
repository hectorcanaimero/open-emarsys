//go:build integration

// Integration tests against a real Postgres, run with:
//
//	go test -tags integration ./libs/go/oe/pg/...
//
// They need testcontainers-go and its postgres module, which this task
// left out of go.mod (out of scope: "No editar go.mod"). Before running
// these, add and tidy:
//
//	github.com/testcontainers/testcontainers-go
//	github.com/testcontainers/testcontainers-go/modules/postgres
package pg_test

import (
	"context"
	"net/url"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"

	oepg "github.com/open-emarsys/oe/libs/go/oe/pg"
	"github.com/open-emarsys/oe/libs/go/oe/tenant"
)

func startPostgres(t *testing.T) string {
	t.Helper()
	ctx := context.Background()

	ctr, err := tcpostgres.Run(ctx, "postgres:17",
		tcpostgres.WithDatabase("oe_test"),
		tcpostgres.WithUsername("oe"),
		tcpostgres.WithPassword("oe"),
	)
	if err != nil {
		t.Fatalf("start postgres container: %v", err)
	}
	t.Cleanup(func() {
		if err := testcontainers.TerminateContainer(ctr); err != nil {
			t.Logf("terminate postgres container: %v", err)
		}
	})

	dsn, err := ctr.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("connection string: %v", err)
	}
	return dsn
}

// TestInTenantTx_RLS proves that a table with RLS policy
// `tenant_id = current_setting('app.tenant_id')::uuid`, queried inside
// InTenantTx, only returns rows for the tenant carried by the context —
// as long as the querying role is not a superuser/owner, since those
// bypass RLS regardless of FORCE ROW LEVEL SECURITY. So this test creates
// a separate, unprivileged role for the tenant-scoped queries.
func TestInTenantTx_RLS(t *testing.T) {
	ctx := context.Background()
	adminDSN := startPostgres(t)

	adminPool, err := oepg.NewPool(ctx, adminDSN)
	if err != nil {
		t.Fatalf("admin pool: %v", err)
	}
	defer adminPool.Close()

	_, err = adminPool.Exec(ctx, `
		CREATE ROLE app_user LOGIN PASSWORD 'app';
		CREATE TABLE widgets (
			id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
			tenant_id uuid NOT NULL,
			name      text NOT NULL
		);
		GRANT SELECT, INSERT ON widgets TO app_user;
		GRANT USAGE, SELECT ON SEQUENCE widgets_id_seq TO app_user;
		ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;
		ALTER TABLE widgets FORCE ROW LEVEL SECURITY;
		CREATE POLICY tenant_isolation ON widgets
			USING (tenant_id = current_setting('app.tenant_id')::uuid);
	`)
	if err != nil {
		t.Fatalf("setup schema: %v", err)
	}

	tenantA := uuid.New()
	tenantB := uuid.New()
	_, err = adminPool.Exec(ctx,
		`INSERT INTO widgets (tenant_id, name) VALUES ($1, 'a-widget'), ($2, 'b-widget')`,
		tenantA, tenantB)
	if err != nil {
		t.Fatalf("seed rows: %v", err)
	}

	appURL, err := url.Parse(adminDSN)
	if err != nil {
		t.Fatalf("parse dsn: %v", err)
	}
	appURL.User = url.UserPassword("app_user", "app")

	appPool, err := oepg.NewPool(ctx, appURL.String())
	if err != nil {
		t.Fatalf("app pool: %v", err)
	}
	defer appPool.Close()

	ctxA := tenant.WithTenant(ctx, tenantA)

	var names []string
	err = oepg.InTenantTx(ctxA, appPool, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctxA, `SELECT name FROM widgets ORDER BY name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				return err
			}
			names = append(names, name)
		}
		return rows.Err()
	})
	if err != nil {
		t.Fatalf("InTenantTx: %v", err)
	}

	if len(names) != 1 || names[0] != "a-widget" {
		t.Fatalf("tenant A saw rows %v, want only [a-widget]", names)
	}
}
