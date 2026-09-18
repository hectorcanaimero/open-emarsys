// Master key ring (NFR-9): derives per-tenant keys and seals secrets with
// AES-256-GCM. Byte-for-byte compatible with libs/go/oe/keyring; its
// testdata/vectors.json pins the format:
//
//   Derive: HKDF-SHA256(ikm=active key, salt=none, info="oe/<purpose>/<tenant uuid>"), 32 bytes
//   Seal:   subkey = HKDF-SHA256(ikm=key[kid], salt=none, info="oe-seal/<purpose>"), 32 bytes
//           "v1.<kid>.<base64url(nonce 12B)>.<base64url(ciphertext||tag)>", base64url without padding, no AAD
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const KEY_SIZE = 32;
const VERSION = 'v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class UnknownKidError extends Error {
  constructor(kid: string) {
    super(`keyring: unknown kid "${kid}"`);
  }
}

export class MalformedEnvelopeError extends Error {
  constructor() {
    super('keyring: malformed envelope');
  }
}

export class Keyring {
  private readonly keys: Map<string, Buffer>;

  /** Every key must be 32 bytes and `active` must be one of them. */
  constructor(keys: Map<string, Buffer>, readonly activeKid: string) {
    if (!activeKid) throw new Error('keyring: OE_MASTER_KEY_ID is empty');
    this.keys = new Map();
    for (const [kid, key] of keys) {
      if (!kid || /[.,: ]/.test(kid)) throw new Error(`keyring: invalid kid "${kid}"`);
      if (key.length !== KEY_SIZE) {
        throw new Error(`keyring: key "${kid}" is ${key.length} bytes, want ${KEY_SIZE}`);
      }
      this.keys.set(kid, Buffer.from(key));
    }
    if (!this.keys.has(activeKid)) {
      throw new Error(`keyring: active kid "${activeKid}" is not in the ring`);
    }
  }

  /** Loads OE_MASTER_KEYS ("kid:base64,kid:base64") and OE_MASTER_KEY_ID. Call at startup and exit on error. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): Keyring {
    return Keyring.parse(env.OE_MASTER_KEYS ?? '', env.OE_MASTER_KEY_ID ?? '');
  }

  static parse(spec: string, active: string): Keyring {
    if (!spec.trim()) throw new Error('keyring: OE_MASTER_KEYS is empty');
    const keys = new Map<string, Buffer>();
    for (const entry of spec.split(',')) {
      const trimmed = entry.trim();
      const i = trimmed.indexOf(':');
      if (i < 0) throw new Error(`keyring: entry "${entry}" is not kid:base64`);
      const kid = trimmed.slice(0, i);
      const b64 = trimmed.slice(i + 1);
      const key = Buffer.from(b64, 'base64');
      // Buffer is lenient; match Go's strict StdEncoding.
      if (key.toString('base64') !== b64) throw new Error(`keyring: key "${kid}" is not valid base64`);
      if (keys.has(kid)) throw new Error(`keyring: duplicate kid "${kid}"`);
      keys.set(kid, key);
    }
    return new Keyring(keys, active);
  }

  /** 32-byte key for purpose and tenant from the active master key. Rotating the active key changes every derived key. */
  derive(purpose: string, tenantId: string): Buffer {
    if (!UUID_RE.test(tenantId)) throw new Error(`keyring: tenant id "${tenantId}" is not a uuid`);
    return hkdfKey(this.keys.get(this.activeKid)!, `oe/${purpose}/${tenantId.toLowerCase()}`);
  }

  /** Encrypts plaintext with the active key's subkey for purpose. */
  seal(purpose: string, plaintext: Buffer | string, nonce: Buffer = randomBytes(12)): string {
    const cipher = createCipheriv('aes-256-gcm', hkdfKey(this.keys.get(this.activeKid)!, `oe-seal/${purpose}`), nonce);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return [VERSION, this.activeKid, b64url(nonce), b64url(ct)].join('.');
  }

  /** Decrypts an envelope with the key named by its kid, active or not. */
  open(purpose: string, sealed: string): Buffer {
    const parts = sealed.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) throw new MalformedEnvelopeError();
    const key = this.keys.get(parts[1]);
    if (!key) throw new UnknownKidError(parts[1]);
    const nonce = fromB64url(parts[2]);
    const ct = fromB64url(parts[3]);
    if (nonce.length !== 12 || ct.length < 16) throw new MalformedEnvelopeError();
    const decipher = createDecipheriv('aes-256-gcm', hkdfKey(key, `oe-seal/${purpose}`), nonce);
    decipher.setAuthTag(ct.subarray(ct.length - 16));
    try {
      return Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
    } catch {
      throw new Error('keyring: decryption failed');
    }
  }
}

function hkdfKey(master: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, KEY_SIZE));
}

function b64url(b: Buffer): string {
  return b.toString('base64url');
}

function fromB64url(s: string): Buffer {
  const b = Buffer.from(s, 'base64url');
  if (b64url(b) !== s) throw new MalformedEnvelopeError();
  return b;
}
