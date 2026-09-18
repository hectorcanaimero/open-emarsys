package chx

import (
	"context"
	"errors"
	"testing"
)

// Query must reject SQL that doesn't reference {tenant_id:UUID} before
// ever touching the connection, so a nil Client is enough to exercise it.
func TestQuery_RejectsMissingTenantParam(t *testing.T) {
	c := &Client{}

	_, err := c.Query(context.Background(), "SELECT * FROM events")
	if !errors.Is(err, ErrMissingTenantParam) {
		t.Fatalf("Query() error = %v, want ErrMissingTenantParam", err)
	}
}
