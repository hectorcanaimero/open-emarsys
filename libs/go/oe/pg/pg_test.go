package pg

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
)

// InTenantTx must reject a context with no tenant before ever touching the
// pool, so passing a nil pool here still exercises the real code path.
func TestInTenantTx_NoTenantInContext(t *testing.T) {
	called := false
	err := InTenantTx(context.Background(), nil, func(pgx.Tx) error {
		called = true
		return nil
	})

	if !errors.Is(err, ErrNoTenant) {
		t.Fatalf("InTenantTx() error = %v, want ErrNoTenant", err)
	}
	if called {
		t.Fatal("InTenantTx() called fn despite missing tenant")
	}
}
