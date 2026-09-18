// Package keyring holds the master key ring (NFR-9): it derives per-tenant
// keys and seals secrets with AES-256-GCM. The envelope format is shared
// with packages/ts-common/src/keyring, so both sides must stay byte-for-byte
// compatible; testdata/vectors.json pins it.
//
// Format:
//
//	Derive:  HKDF-SHA256(ikm=active key, salt=none, info="oe/<purpose>/<tenant uuid>"), 32 bytes
//	Seal:    subkey = HKDF-SHA256(ikm=key[kid], salt=none, info="oe-seal/<purpose>"), 32 bytes
//	         "v1.<kid>.<base64url(nonce 12B)>.<base64url(ciphertext||tag)>", base64url without padding, no AAD
package keyring

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/google/uuid"
)

const (
	keySize = 32
	version = "v1"
)

var (
	ErrUnknownKID = errors.New("keyring: unknown kid")
	ErrMalformed  = errors.New("keyring: malformed envelope")
)

// Keyring is a set of 32-byte master keys by kid, one of them active.
// It is safe for concurrent use.
type Keyring struct {
	active string
	keys   map[string][]byte
}

// FromEnv loads the ring from OE_MASTER_KEYS ("kid:base64,kid:base64") and
// OE_MASTER_KEY_ID. Services call it at startup and exit on error.
func FromEnv() (*Keyring, error) {
	return Parse(os.Getenv("OE_MASTER_KEYS"), os.Getenv("OE_MASTER_KEY_ID"))
}

// Parse builds a ring from the OE_MASTER_KEYS format.
func Parse(spec, active string) (*Keyring, error) {
	if strings.TrimSpace(spec) == "" {
		return nil, errors.New("keyring: OE_MASTER_KEYS is empty")
	}
	keys := map[string][]byte{}
	for _, entry := range strings.Split(spec, ",") {
		kid, b64, ok := strings.Cut(strings.TrimSpace(entry), ":")
		if !ok {
			return nil, fmt.Errorf("keyring: entry %q is not kid:base64", entry)
		}
		key, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			return nil, fmt.Errorf("keyring: key %q is not valid base64: %w", kid, err)
		}
		if _, dup := keys[kid]; dup {
			return nil, fmt.Errorf("keyring: duplicate kid %q", kid)
		}
		keys[kid] = key
	}
	return New(keys, active)
}

// New builds a ring from raw keys. Every key must be 32 bytes and active
// must be one of them.
func New(keys map[string][]byte, active string) (*Keyring, error) {
	if active == "" {
		return nil, errors.New("keyring: OE_MASTER_KEY_ID is empty")
	}
	ring := &Keyring{active: active, keys: make(map[string][]byte, len(keys))}
	for kid, key := range keys {
		if kid == "" || strings.ContainsAny(kid, ".,: ") {
			return nil, fmt.Errorf("keyring: invalid kid %q", kid)
		}
		if len(key) != keySize {
			return nil, fmt.Errorf("keyring: key %q is %d bytes, want %d", kid, len(key), keySize)
		}
		ring.keys[kid] = append([]byte(nil), key...)
	}
	if _, ok := ring.keys[active]; !ok {
		return nil, fmt.Errorf("keyring: active kid %q is not in the ring", active)
	}
	return ring, nil
}

// ActiveKID returns the kid new envelopes are sealed with.
func (k *Keyring) ActiveKID() string { return k.active }

// Derive returns a 32-byte key for purpose and tenant from the active master
// key. Rotating the active key changes every derived key.
func (k *Keyring) Derive(purpose string, tenantID uuid.UUID) []byte {
	return hkdfKey(k.keys[k.active], "oe/"+purpose+"/"+tenantID.String())
}

// Seal encrypts plaintext with the active key's subkey for purpose.
func (k *Keyring) Seal(purpose string, plaintext []byte) (string, error) {
	nonce := make([]byte, 12)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("keyring: nonce: %w", err)
	}
	return k.seal(purpose, plaintext, nonce)
}

func (k *Keyring) seal(purpose string, plaintext, nonce []byte) (string, error) {
	aead, err := gcm(k.keys[k.active], purpose)
	if err != nil {
		return "", err
	}
	ct := aead.Seal(nil, nonce, plaintext, nil)
	b64 := base64.RawURLEncoding
	return strings.Join([]string{version, k.active, b64.EncodeToString(nonce), b64.EncodeToString(ct)}, "."), nil
}

// Open decrypts an envelope with the key named by its kid, active or not.
func (k *Keyring) Open(purpose, sealed string) ([]byte, error) {
	parts := strings.Split(sealed, ".")
	if len(parts) != 4 || parts[0] != version {
		return nil, ErrMalformed
	}
	key, ok := k.keys[parts[1]]
	if !ok {
		return nil, fmt.Errorf("%w %q", ErrUnknownKID, parts[1])
	}
	b64 := base64.RawURLEncoding
	nonce, err := b64.DecodeString(parts[2])
	if err != nil || len(nonce) != 12 {
		return nil, ErrMalformed
	}
	ct, err := b64.DecodeString(parts[3])
	if err != nil {
		return nil, ErrMalformed
	}
	aead, err := gcm(key, purpose)
	if err != nil {
		return nil, err
	}
	pt, err := aead.Open(nil, nonce, ct, nil)
	if err != nil {
		return nil, errors.New("keyring: decryption failed")
	}
	return pt, nil
}

func gcm(master []byte, purpose string) (cipher.AEAD, error) {
	block, err := aes.NewCipher(hkdfKey(master, "oe-seal/"+purpose))
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func hkdfKey(master []byte, info string) []byte {
	// Only fails for lengths above 255*32 bytes.
	out, err := hkdf.Key(sha256.New, master, nil, info, keySize)
	if err != nil {
		panic(err)
	}
	return out
}
