package auth

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"github.com/open-emarsys/oe/libs/go/oe/tenant"
)

const tenantA = "0191e4a2-1111-7000-8000-000000000001"

var (
	keyOld = mustKey()
	keyNew = mustKey()
)

func mustKey() *rsa.PrivateKey {
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	return k
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func sign(t *testing.T, key *rsa.PrivateKey, kid string, claims map[string]any) string {
	t.Helper()
	h, _ := json.Marshal(map[string]string{"alg": "RS256", "typ": "JWT", "kid": kid})
	p, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	in := b64(h) + "." + b64(p)
	sum := sha256.Sum256([]byte(in))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return in + "." + b64(sig)
}

// jwksServer serves a mutable test JWKS and counts fetches.
type jwksServer struct {
	*httptest.Server
	mu   sync.Mutex
	keys map[string]*rsa.PrivateKey
	hits int
}

func newJWKS(t *testing.T, keys map[string]*rsa.PrivateKey) *jwksServer {
	s := &jwksServer{keys: keys}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/jwks.json" {
			http.NotFound(w, r)
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		s.hits++
		var out []map[string]string
		for kid, k := range s.keys {
			out = append(out, map[string]string{
				"kty": "RSA", "use": "sig", "alg": "RS256", "kid": kid,
				"n": b64(k.N.Bytes()), "e": b64(big.NewInt(int64(k.E)).Bytes()),
			})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": out})
	}))
	t.Cleanup(s.Close)
	return s
}

func (s *jwksServer) set(keys map[string]*rsa.PrivateKey) {
	s.mu.Lock()
	s.keys = keys
	s.mu.Unlock()
}

func (s *jwksServer) fetches() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.hits
}

func claims(now time.Time, typ string, extra map[string]any) map[string]any {
	c := map[string]any{
		"sub": "0191e4a2-7b3c-7d10-9a55-2f7c1d3e4b60", "typ": typ, "tenant_id": tenantA,
		"iat": now.Unix(), "exp": now.Add(15 * time.Minute).Unix(),
	}
	switch typ {
	case "user":
		c["perms"] = []string{"campaigns:view", "contacts:edit"}
	default:
		c["scopes"] = []string{"campaigns:view"}
	}
	for k, v := range extra {
		c[k] = v
	}
	return c
}

func TestRequire(t *testing.T) {
	srv := newJWKS(t, map[string]*rsa.PrivateKey{"k1": keyOld})
	v := NewVerifier(srv.URL)
	now := time.Now()

	noTenant := claims(now, "user", nil)
	delete(noTenant, "tenant_id")

	cases := []struct {
		name  string
		path  string
		token string
		want  int
	}{
		{"valid user", "/campaigns", sign(t, keyOld, "k1", claims(now, "user", nil)), 200},
		{"valid client scopes", "/campaigns", sign(t, keyOld, "k1", claims(now, "client", nil)), 200},
		{"operator user, null tenant", "/campaigns", sign(t, keyOld, "k1", claims(now, "user", map[string]any{"tenant_id": nil})), 200},
		{"expired", "/campaigns", sign(t, keyOld, "k1", claims(now, "user", map[string]any{"exp": now.Add(-2 * time.Minute).Unix()})), 401},
		{"expired within skew", "/campaigns", sign(t, keyOld, "k1", claims(now, "user", map[string]any{"exp": now.Add(-30 * time.Second).Unix()})), 200},
		{"iat in the future", "/campaigns", sign(t, keyOld, "k1", claims(now, "user", map[string]any{"iat": now.Add(5 * time.Minute).Unix()})), 401},
		{"invalid signature", "/campaigns", sign(t, keyNew, "k1", claims(now, "user", nil)), 401},
		{"unknown kid", "/campaigns", sign(t, keyNew, "k9", claims(now, "user", nil)), 401},
		{"no token", "/campaigns", "", 401},
		{"garbage token", "/campaigns", "a.b.c", 401},
		{"tenant user without tenant_id", "/campaigns", sign(t, keyOld, "k1", noTenant), 401},
		{"client with null tenant", "/campaigns", sign(t, keyOld, "k1", claims(now, "client", map[string]any{"tenant_id": nil})), 401},
		{"user carrying scopes", "/campaigns", sign(t, keyOld, "k1", claims(now, "user", map[string]any{"scopes": []string{"campaigns:view"}})), 401},
		{"missing permission", "/campaigns", sign(t, keyOld, "k1", claims(now, "user", map[string]any{"perms": []string{"contacts:edit"}})), 403},
		{"client missing scope", "/campaigns", sign(t, keyOld, "k1", claims(now, "client", map[string]any{"scopes": []string{"contacts:view"}})), 403},
		{"user on /internal", "/internal/v1/render", sign(t, keyOld, "k1", claims(now, "user", nil)), 403},
		{"client on /internal", "/internal/v1/render", sign(t, keyOld, "k1", claims(now, "client", nil)), 403},
		{"service on /internal", "/internal/v1/render", sign(t, keyOld, "k1", claims(now, "service", map[string]any{"tenant_id": nil, "scopes": []string{}})), 200},
		{"service on public route", "/campaigns", sign(t, keyOld, "k1", claims(now, "service", nil)), 403},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotTenant bool
			h := v.Require("campaigns:view")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if _, ok := PrincipalFrom(r.Context()); !ok {
					t.Error("principal missing from context")
				}
				_, gotTenant = tenant.TenantFrom(r.Context())
			}))
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			if tc.token != "" {
				req.Header.Set("Authorization", "Bearer "+tc.token)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, req)
			if w.Code != tc.want {
				t.Fatalf("status: got %d, want %d (%s)", w.Code, tc.want, w.Body.String())
			}
			if tc.name == "valid user" && !gotTenant {
				t.Error("tenant missing from context")
			}
		})
	}
}

func TestVerifierRotatedKid(t *testing.T) {
	srv := newJWKS(t, map[string]*rsa.PrivateKey{"k1": keyOld})
	v := NewVerifier(srv.URL)
	clock := time.Now()
	v.now = func() time.Time { return clock }
	ctx := context.Background()

	if _, err := v.Verify(ctx, sign(t, keyOld, "k1", claims(clock, "user", nil))); err != nil {
		t.Fatalf("k1: %v", err)
	}

	// core rotates to k2; within the first minute the unknown kid does not refetch.
	srv.set(map[string]*rsa.PrivateKey{"k1": keyOld, "k2": keyNew})
	if _, err := v.Verify(ctx, sign(t, keyNew, "k2", claims(clock, "user", nil))); err == nil {
		t.Fatal("k2 accepted before the refresh backoff elapsed")
	}
	if n := srv.fetches(); n != 1 {
		t.Fatalf("fetches: got %d, want 1", n)
	}

	clock = clock.Add(61 * time.Second)
	if _, err := v.Verify(ctx, sign(t, keyNew, "k2", claims(clock, "user", nil))); err != nil {
		t.Fatalf("k2 after rotation: %v", err)
	}
	if n := srv.fetches(); n != 2 {
		t.Fatalf("fetches: got %d, want 2", n)
	}

	// k1 retired; the periodic refresh after 10 minutes drops it.
	srv.set(map[string]*rsa.PrivateKey{"k2": keyNew})
	clock = clock.Add(11 * time.Minute)
	if _, err := v.Verify(ctx, sign(t, keyOld, "k1", claims(clock, "user", nil))); err == nil {
		t.Fatal("retired k1 still accepted after periodic refresh")
	}
}

func TestUnaryServerInterceptor(t *testing.T) {
	srv := newJWKS(t, map[string]*rsa.PrivateKey{"k1": keyOld})
	v := NewVerifier(srv.URL)
	now := time.Now()
	intercept := v.UnaryServerInterceptor()
	handler := func(ctx context.Context, req any) (any, error) {
		if _, ok := PrincipalFrom(ctx); !ok {
			t.Error("principal missing from context")
		}
		return "ok", nil
	}

	cases := []struct {
		name  string
		token string
		want  codes.Code
	}{
		{"service", sign(t, keyOld, "k1", claims(now, "service", map[string]any{"tenant_id": nil})), codes.OK},
		{"user", sign(t, keyOld, "k1", claims(now, "user", nil)), codes.PermissionDenied},
		{"invalid signature", sign(t, keyNew, "k1", claims(now, "service", nil)), codes.Unauthenticated},
		{"no token", "", codes.Unauthenticated},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			if tc.token != "" {
				ctx = metadata.NewIncomingContext(ctx, metadata.Pairs("authorization", "Bearer "+tc.token))
			}
			_, err := intercept(ctx, nil, &grpc.UnaryServerInfo{FullMethod: "/oe.Segments/Count"}, handler)
			if got := status.Code(err); got != tc.want {
				t.Fatalf("code: got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestServiceTokenSource(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/v1/service-token" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		if r.FormValue("grant_type") != "client_credentials" || r.FormValue("client_id") != "dispatcher" || r.FormValue("client_secret") != "s3cret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		hits++
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "tok" + strconv.Itoa(hits), "expires_in": 900})
	}))
	t.Cleanup(srv.Close)

	s := NewServiceTokenSource(srv.URL, "dispatcher", "s3cret")
	clock := time.Now()
	s.now = func() time.Time { return clock }
	ctx := context.Background()

	for _, want := range []string{"tok1", "tok1"} {
		if got, err := s.Token(ctx); err != nil || got != want {
			t.Fatalf("token: got %q, %v; want %q", got, err, want)
		}
	}
	clock = clock.Add(13 * time.Minute) // past 80% of 15 min
	if got, err := s.Token(ctx); err != nil || got != "tok2" {
		t.Fatalf("renewed token: got %q, %v; want tok2", got, err)
	}

	bad := NewServiceTokenSource(srv.URL, "dispatcher", "wrong")
	if _, err := bad.Token(ctx); err == nil {
		t.Fatal("wrong secret: want error")
	}
}
