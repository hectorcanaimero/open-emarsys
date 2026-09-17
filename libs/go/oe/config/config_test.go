package config

import (
	"testing"
	"time"
)

func TestStringDefault(t *testing.T) {
	l := New("HELLO")
	if got := l.String("ADDR", ":8080"); got != ":8080" {
		t.Fatalf("String default: got %q, want %q", got, ":8080")
	}
}

func TestStringSet(t *testing.T) {
	t.Setenv("HELLO_ADDR", ":9090")
	l := New("HELLO")
	if got := l.String("ADDR", ":8080"); got != ":9090" {
		t.Fatalf("String: got %q, want %q", got, ":9090")
	}
}

func TestMustStringMissing(t *testing.T) {
	l := New("HELLO")
	if _, err := l.MustString("JWT_KEYS_DIR"); err == nil {
		t.Fatal("MustString: expected error for missing required env")
	}
}

func TestMustStringPresent(t *testing.T) {
	t.Setenv("HELLO_JWT_KEYS_DIR", "/keys")
	l := New("HELLO")
	got, err := l.MustString("JWT_KEYS_DIR")
	if err != nil {
		t.Fatalf("MustString: unexpected error: %v", err)
	}
	if got != "/keys" {
		t.Fatalf("MustString: got %q, want %q", got, "/keys")
	}
}

func TestIntAndDuration(t *testing.T) {
	t.Setenv("HELLO_PORT", "9090")
	t.Setenv("HELLO_TIMEOUT", "5s")
	l := New("HELLO")

	if got := l.Int("PORT", 8080); got != 9090 {
		t.Fatalf("Int: got %d, want %d", got, 9090)
	}
	if got := l.Int("MISSING", 8080); got != 8080 {
		t.Fatalf("Int default: got %d, want %d", got, 8080)
	}
	if got := l.Duration("TIMEOUT", time.Second); got != 5*time.Second {
		t.Fatalf("Duration: got %s, want %s", got, 5*time.Second)
	}
}

func TestBool(t *testing.T) {
	t.Setenv("HELLO_ENABLED", "true")
	l := New("HELLO")
	if !l.Bool("ENABLED", false) {
		t.Fatal("Bool: got false, want true")
	}
	if !l.Bool("MISSING", true) {
		t.Fatal("Bool default: got false, want true")
	}
}
