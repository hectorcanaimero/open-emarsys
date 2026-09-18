// Package auth verifies core-issued JWTs (RS256 against core's JWKS), enforces
// `module:action` permissions over HTTP and gRPC, and obtains `typ=service`
// tokens for internal calls (C4, C5).
package auth

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	jwksRefreshEvery  = 10 * time.Minute
	unknownKidBackoff = time.Minute // at most one kid-triggered JWKS refresh per minute
	clockSkew         = 60 * time.Second
)

// Principal is the verified caller of a request (JwtClaims in
// contracts/openapi/admin-v1/identity.yaml).
type Principal struct {
	Subject string
	Type    string // "user", "client" or "service"
	// TenantID is nil for operator users and cross-tenant service tokens.
	TenantID *uuid.UUID
	// Perms holds `perms` for users and `scopes` for clients and services.
	Perms []string
}

// Verifier checks RS256 JWTs against the JWKS published by core.
type Verifier struct {
	jwksURL string
	client  *http.Client
	now     func() time.Time

	mu        sync.Mutex
	keys      map[string]*rsa.PublicKey
	fetchedAt time.Time
}

// NewVerifier returns a Verifier for the core at coreURL (e.g.
// "http://core:3000"). Keys are fetched lazily on the first Verify.
func NewVerifier(coreURL string) *Verifier {
	return &Verifier{
		jwksURL: strings.TrimRight(coreURL, "/") + "/.well-known/jwks.json",
		client:  &http.Client{Timeout: 5 * time.Second},
		now:     time.Now,
	}
}

// Verify checks the token's signature and claims and returns its principal.
func (v *Verifier) Verify(ctx context.Context, token string) (*Principal, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("auth: malformed token")
	}
	var header struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if err := decodeSegment(parts[0], &header); err != nil {
		return nil, fmt.Errorf("auth: header: %w", err)
	}
	if header.Alg != "RS256" {
		return nil, fmt.Errorf("auth: unsupported alg %q", header.Alg)
	}
	key, err := v.key(ctx, header.Kid)
	if err != nil {
		return nil, err
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, fmt.Errorf("auth: signature: %w", err)
	}
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(key, crypto.SHA256, sum[:], sig); err != nil {
		return nil, errors.New("auth: invalid signature")
	}
	return parseClaims(parts[1], v.now())
}

// key returns the public key for kid, refreshing the JWKS every 10 minutes
// and, for an unknown kid, at most once per minute.
// ponytail: the lock is held during the fetch, so a slow core stalls every
// verification for up to the client timeout; fine at our request rates.
func (v *Verifier) key(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	now := v.now()
	since := now.Sub(v.fetchedAt)
	if k, ok := v.keys[kid]; ok && since < jwksRefreshEvery {
		return k, nil
	}
	if since >= unknownKidBackoff {
		// Stamp before fetching so a failing core is retried at most once a minute.
		v.fetchedAt = now
		if err := v.fetch(ctx); err != nil && len(v.keys) == 0 {
			return nil, err
		}
	}
	if k, ok := v.keys[kid]; ok {
		return k, nil
	}
	return nil, fmt.Errorf("auth: unknown kid %q", kid)
}

func (v *Verifier) fetch(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.jwksURL, nil)
	if err != nil {
		return err
	}
	resp, err := v.client.Do(req)
	if err != nil {
		return fmt.Errorf("auth: fetch jwks: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("auth: fetch jwks: status %d", resp.StatusCode)
	}
	var set struct {
		Keys []struct {
			Kty string `json:"kty"`
			Kid string `json:"kid"`
			Use string `json:"use"`
			Alg string `json:"alg"`
			N   string `json:"n"`
			E   string `json:"e"`
		} `json:"keys"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&set); err != nil {
		return fmt.Errorf("auth: decode jwks: %w", err)
	}
	keys := make(map[string]*rsa.PublicKey, len(set.Keys))
	for _, k := range set.Keys {
		if k.Kty != "RSA" || k.Kid == "" || (k.Use != "" && k.Use != "sig") || (k.Alg != "" && k.Alg != "RS256") {
			continue
		}
		n, errN := base64.RawURLEncoding.DecodeString(k.N)
		e, errE := base64.RawURLEncoding.DecodeString(k.E)
		if errN != nil || errE != nil || len(e) == 0 || len(e) > 4 {
			continue
		}
		keys[k.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
	}
	v.keys = keys
	return nil
}

func parseClaims(segment string, now time.Time) (*Principal, error) {
	var c struct {
		Sub      string          `json:"sub"`
		Typ      string          `json:"typ"`
		TenantID json.RawMessage `json:"tenant_id"`
		Perms    *[]string       `json:"perms"`
		Scopes   *[]string       `json:"scopes"`
		Iat      *int64          `json:"iat"`
		Exp      *int64          `json:"exp"`
	}
	if err := decodeSegment(segment, &c); err != nil {
		return nil, fmt.Errorf("auth: claims: %w", err)
	}
	if c.Sub == "" || c.Iat == nil || c.Exp == nil || len(c.TenantID) == 0 {
		return nil, errors.New("auth: missing required claim")
	}
	if now.After(time.Unix(*c.Exp, 0).Add(clockSkew)) {
		return nil, errors.New("auth: token expired")
	}
	if time.Unix(*c.Iat, 0).After(now.Add(clockSkew)) {
		return nil, errors.New("auth: token issued in the future")
	}

	p := &Principal{Subject: c.Sub, Type: c.Typ}
	switch c.Typ {
	case "user":
		if c.Perms == nil || c.Scopes != nil {
			return nil, errors.New("auth: user token must carry perms and not scopes")
		}
		p.Perms = *c.Perms
	case "client", "service":
		if c.Scopes == nil || c.Perms != nil {
			return nil, errors.New("auth: client/service token must carry scopes and not perms")
		}
		p.Perms = *c.Scopes
	default:
		return nil, fmt.Errorf("auth: unknown typ %q", c.Typ)
	}

	if string(c.TenantID) != "null" {
		var s string
		if err := json.Unmarshal(c.TenantID, &s); err != nil {
			return nil, errors.New("auth: tenant_id is not a string")
		}
		id, err := uuid.Parse(s)
		if err != nil {
			return nil, errors.New("auth: tenant_id is not a UUID")
		}
		p.TenantID = &id
	} else if c.Typ == "client" {
		return nil, errors.New("auth: client token without tenant_id")
	}
	return p, nil
}

func decodeSegment(s string, v any) error {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}
