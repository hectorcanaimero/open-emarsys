// Package config loads configuration from environment variables namespaced
// by a per-service prefix, e.g. New("CORE").MustString("JWT_KEYS_DIR") reads
// CORE_JWT_KEYS_DIR.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Loader reads env vars under a fixed prefix.
type Loader struct {
	prefix string
}

// New returns a Loader for the given service prefix (case-insensitive).
func New(prefix string) *Loader {
	return &Loader{prefix: strings.ToUpper(prefix)}
}

func (l *Loader) envKey(key string) string {
	return l.prefix + "_" + key
}

func (l *Loader) lookup(key string) (string, bool) {
	v, ok := os.LookupEnv(l.envKey(key))
	if !ok || v == "" {
		return "", false
	}
	return v, true
}

// String returns the env var for key, or def if it is unset or empty.
func (l *Loader) String(key, def string) string {
	if v, ok := l.lookup(key); ok {
		return v
	}
	return def
}

// MustString returns the env var for key, or an error if it is unset or empty.
func (l *Loader) MustString(key string) (string, error) {
	if v, ok := l.lookup(key); ok {
		return v, nil
	}
	return "", fmt.Errorf("config: missing required env %s", l.envKey(key))
}

// Int returns the env var for key parsed as an int, or def if unset, empty
// or not a valid int.
func (l *Loader) Int(key string, def int) int {
	v, ok := l.lookup(key)
	if !ok {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

// MustInt returns the env var for key parsed as an int, or an error if it is
// unset, empty or not a valid int.
func (l *Loader) MustInt(key string) (int, error) {
	v, err := l.MustString(key)
	if err != nil {
		return 0, err
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("config: env %s is not an int: %w", l.envKey(key), err)
	}
	return n, nil
}

// Bool returns the env var for key parsed with strconv.ParseBool, or def if
// unset, empty or not a valid bool.
func (l *Loader) Bool(key string, def bool) bool {
	v, ok := l.lookup(key)
	if !ok {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

// Duration returns the env var for key parsed with time.ParseDuration, or
// def if unset, empty or not a valid duration.
func (l *Loader) Duration(key string, def time.Duration) time.Duration {
	v, ok := l.lookup(key)
	if !ok {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return def
	}
	return d
}
