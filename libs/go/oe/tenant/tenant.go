// Package tenant carries the current tenant UUID through a context.Context.
package tenant

import (
	"context"

	"github.com/google/uuid"
)

type ctxKey struct{}

// WithTenant returns a copy of ctx carrying id as the current tenant.
func WithTenant(ctx context.Context, id uuid.UUID) context.Context {
	return context.WithValue(ctx, ctxKey{}, id)
}

// TenantFrom returns the tenant UUID carried by ctx, if any.
func TenantFrom(ctx context.Context) (uuid.UUID, bool) {
	id, ok := ctx.Value(ctxKey{}).(uuid.UUID)
	return id, ok
}
