package tenant

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func TestWithTenantAndTenantFrom(t *testing.T) {
	id := uuid.New()
	ctx := WithTenant(context.Background(), id)

	got, ok := TenantFrom(ctx)
	if !ok {
		t.Fatal("TenantFrom: expected ok = true")
	}
	if got != id {
		t.Fatalf("TenantFrom: got %s, want %s", got, id)
	}
}

func TestTenantFromMissing(t *testing.T) {
	_, ok := TenantFrom(context.Background())
	if ok {
		t.Fatal("TenantFrom: expected ok = false on empty context")
	}
}
