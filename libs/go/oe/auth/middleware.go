package auth

import (
	"context"
	"net/http"
	"slices"
	"strings"

	"github.com/open-emarsys/oe/libs/go/oe/httpx"
	"github.com/open-emarsys/oe/libs/go/oe/tenant"
)

type principalKey struct{}

// WithPrincipal returns a copy of ctx carrying p and, if p has one, its tenant
// (see package tenant).
func WithPrincipal(ctx context.Context, p *Principal) context.Context {
	ctx = context.WithValue(ctx, principalKey{}, p)
	if p.TenantID != nil {
		ctx = tenant.WithTenant(ctx, *p.TenantID)
	}
	return ctx
}

// PrincipalFrom returns the principal stored by Require or the gRPC interceptor.
func PrincipalFrom(ctx context.Context) (*Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(*Principal)
	return p, ok
}

// Require rejects requests without a valid bearer token (401) or without
// every one of perms (403). `typ=service` tokens are accepted only on
// `/internal/*` routes, and only they are; users need perms in `perms`,
// clients in `scopes`.
func (v *Verifier) Require(perms ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p, err := v.Verify(r.Context(), bearer(r.Header.Get("Authorization")))
			if err != nil {
				w.Header().Set("WWW-Authenticate", "Bearer")
				httpx.WriteProblem(w, http.StatusUnauthorized, "Unauthorized", "missing or invalid bearer token")
				return
			}
			if !allowed(p, strings.HasPrefix(r.URL.Path, "/internal/"), perms) {
				httpx.WriteProblem(w, http.StatusForbidden, "Forbidden", "insufficient permissions")
				return
			}
			next.ServeHTTP(w, r.WithContext(WithPrincipal(r.Context(), p)))
		})
	}
}

// allowed reports whether p may call a route. Service tokens bypass perms on
// internal routes: they are trusted callers and never reach public routes.
func allowed(p *Principal, internal bool, perms []string) bool {
	if internal || p.Type == "service" {
		return internal && p.Type == "service"
	}
	for _, want := range perms {
		if !slices.Contains(p.Perms, want) {
			return false
		}
	}
	return true
}

func bearer(header string) string {
	scheme, token, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return ""
	}
	return strings.TrimSpace(token)
}
