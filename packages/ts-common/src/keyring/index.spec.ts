import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Keyring, UnknownKidError } from './index.js';

const vectors = JSON.parse(
  readFileSync(new URL('../../../../libs/go/oe/keyring/testdata/vectors.json', import.meta.url), 'utf8'),
) as {
  master_keys: string;
  master_key_id: string;
  derive: { purpose: string; tenant_id: string; key_hex: string }[];
  seal: { purpose: string; plaintext: string; nonce_hex: string; sealed: string }[];
};

const k1 = Buffer.alloc(32, 1).toString('base64');
const k2 = Buffer.alloc(32, 2).toString('base64');

describe('keyring', () => {
  it('round-trips seal/open', () => {
    const ring = Keyring.parse(`k1:${k1}`, 'k1');
    const sealed = ring.seal('dkim', 'secreto');
    expect(sealed.startsWith('v1.k1.')).toBe(true);
    expect(ring.open('dkim', sealed).toString()).toBe('secreto');
    expect(() => ring.open('webhook', sealed)).toThrow(/decryption failed/);
  });

  it('opens envelopes sealed with a rotated-out key', () => {
    const old = Keyring.parse(`k1:${k1}`, 'k1').seal('dkim', 'viejo');
    const ring = Keyring.parse(`k1:${k1},k2:${k2}`, 'k2');
    expect(ring.open('dkim', old).toString()).toBe('viejo');
    expect(ring.seal('dkim', 'nuevo').startsWith('v1.k2.')).toBe(true);
  });

  it('rejects an unknown kid', () => {
    const sealed = Keyring.parse(`k2:${k2}`, 'k2').seal('dkim', 'x');
    expect(() => Keyring.parse(`k1:${k1}`, 'k1').open('dkim', sealed)).toThrow(UnknownKidError);
  });

  it('fails at startup without env', () => {
    expect(() => Keyring.fromEnv({})).toThrow(/OE_MASTER_KEYS/);
    expect(() => Keyring.fromEnv({ OE_MASTER_KEYS: `k1:${k1}` })).toThrow(/OE_MASTER_KEY_ID/);
    expect(() => Keyring.parse('k1:AAAA', 'k1')).toThrow(/bytes/);
  });

  it('matches the Go vectors', () => {
    const ring = Keyring.fromEnv({ OE_MASTER_KEYS: vectors.master_keys, OE_MASTER_KEY_ID: vectors.master_key_id });
    for (const v of vectors.derive) {
      expect(ring.derive(v.purpose, v.tenant_id).toString('hex')).toBe(v.key_hex);
    }
    for (const v of vectors.seal) {
      expect(ring.open(v.purpose, v.sealed).toString()).toBe(v.plaintext);
      expect(ring.seal(v.purpose, v.plaintext, Buffer.from(v.nonce_hex, 'hex'))).toBe(v.sealed);
    }
  });
});
