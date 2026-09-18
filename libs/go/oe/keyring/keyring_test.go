package keyring

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
)

var update = flag.Bool("update", false, "rewrite testdata/vectors.json")

func b64key(b byte) string { return base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{b}, 32)) }

func mustParse(t *testing.T, spec, active string) *Keyring {
	t.Helper()
	k, err := Parse(spec, active)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func TestParseErrors(t *testing.T) {
	short := base64.StdEncoding.EncodeToString(make([]byte, 16))
	cases := map[string][2]string{
		"empty":          {"", "k1"},
		"no active":      {"k1:" + b64key(1), ""},
		"active missing": {"k1:" + b64key(1), "k2"},
		"short key":      {"k1:" + short, "k1"},
		"bad base64":     {"k1:!!!", "k1"},
		"no colon":       {"k1", "k1"},
		"dot in kid":     {"k.1:" + b64key(1), "k.1"},
		"duplicate":      {"k1:" + b64key(1) + ",k1:" + b64key(2), "k1"},
	}
	for name, c := range cases {
		if _, err := Parse(c[0], c[1]); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
}

func TestFromEnv(t *testing.T) {
	t.Setenv("OE_MASTER_KEYS", "")
	t.Setenv("OE_MASTER_KEY_ID", "")
	if _, err := FromEnv(); err == nil {
		t.Fatal("want error with no env")
	}
	t.Setenv("OE_MASTER_KEYS", "k1:"+b64key(1))
	t.Setenv("OE_MASTER_KEY_ID", "k1")
	if _, err := FromEnv(); err != nil {
		t.Fatal(err)
	}
}

func TestSealOpenRoundTrip(t *testing.T) {
	k := mustParse(t, "k1:"+b64key(1), "k1")
	sealed, err := k.Seal("dkim", []byte("secret"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(sealed, "v1.k1.") {
		t.Fatalf("envelope %q", sealed)
	}
	pt, err := k.Open("dkim", sealed)
	if err != nil || string(pt) != "secret" {
		t.Fatalf("got %q, %v", pt, err)
	}
	if _, err := k.Open("webhook", sealed); err == nil {
		t.Fatal("open with another purpose must fail")
	}
	tampered := sealed[:len(sealed)-2] + "AA"
	if _, err := k.Open("dkim", tampered); err == nil {
		t.Fatal("tampered envelope must fail")
	}
}

func TestRotation(t *testing.T) {
	old := mustParse(t, "k1:"+b64key(1), "k1")
	sealed, _ := old.Seal("dkim", []byte("secret"))

	rotated := mustParse(t, "k1:"+b64key(1)+",k2:"+b64key(2), "k2")
	pt, err := rotated.Open("dkim", sealed)
	if err != nil || string(pt) != "secret" {
		t.Fatalf("old envelope: %q, %v", pt, err)
	}
	resealed, _ := rotated.Seal("dkim", pt)
	if !strings.HasPrefix(resealed, "v1.k2.") {
		t.Fatalf("reseal used %q", resealed)
	}
}

func TestUnknownKID(t *testing.T) {
	k1 := mustParse(t, "k1:"+b64key(1), "k1")
	k2 := mustParse(t, "k2:"+b64key(2), "k2")
	sealed, _ := k1.Seal("dkim", []byte("x"))
	if _, err := k2.Open("dkim", sealed); !errors.Is(err, ErrUnknownKID) {
		t.Fatalf("want ErrUnknownKID, got %v", err)
	}
	for _, bad := range []string{"", "v1.k2.a", "v2.k2.AAAAAAAAAAAAAAAA.AA", "v1.k2.AA.AA"} {
		if _, err := k2.Open("dkim", bad); !errors.Is(err, ErrMalformed) {
			t.Errorf("%q: want ErrMalformed, got %v", bad, err)
		}
	}
}

func TestDeriveDistinct(t *testing.T) {
	k := mustParse(t, "k1:"+b64key(1), "k1")
	a, b := uuid.New(), uuid.New()
	seen := map[string]bool{}
	for _, d := range [][]byte{k.Derive("track", a), k.Derive("track", b), k.Derive("other", a)} {
		if len(d) != 32 || seen[string(d)] {
			t.Fatal("derivations must be 32 bytes and distinct")
		}
		seen[string(d)] = true
	}
	if !bytes.Equal(k.Derive("track", a), k.Derive("track", a)) {
		t.Fatal("derive must be deterministic")
	}
}

// vectors.json pins the format for packages/ts-common/src/keyring (F0.5.T5).
// Regenerate with: go test ./libs/go/oe/keyring -run TestVectors -update
type vectors struct {
	MasterKeys  string `json:"master_keys"`
	MasterKeyID string `json:"master_key_id"`
	Derive      []struct {
		Purpose  string `json:"purpose"`
		TenantID string `json:"tenant_id"`
		KeyHex   string `json:"key_hex"`
	} `json:"derive"`
	Seal []struct {
		Purpose   string `json:"purpose"`
		Plaintext string `json:"plaintext"`
		NonceHex  string `json:"nonce_hex"`
		Sealed    string `json:"sealed"`
	} `json:"seal"`
}

func TestVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	k := mustParse(t, v.MasterKeys, v.MasterKeyID)
	for i, d := range v.Derive {
		got := hex.EncodeToString(k.Derive(d.Purpose, uuid.MustParse(d.TenantID)))
		if *update {
			v.Derive[i].KeyHex = got
		} else if got != d.KeyHex {
			t.Errorf("derive %s/%s: got %s want %s", d.Purpose, d.TenantID, got, d.KeyHex)
		}
	}
	for i, s := range v.Seal {
		if *update {
			nonce, _ := hex.DecodeString(s.NonceHex)
			v.Seal[i].Sealed, err = k.seal(s.Purpose, []byte(s.Plaintext), nonce)
			if err != nil {
				t.Fatal(err)
			}
			continue
		}
		pt, err := k.Open(s.Purpose, s.Sealed)
		if err != nil || string(pt) != s.Plaintext {
			t.Errorf("open %s: got %q, %v", s.Sealed, pt, err)
		}
	}
	if *update {
		out, _ := json.MarshalIndent(v, "", "  ")
		if err := os.WriteFile("testdata/vectors.json", append(out, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}
