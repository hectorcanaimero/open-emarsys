import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildEnvelope, subjectFor, uuidv7 } from './envelope.js';

// Mirrors contracts/events/envelope.schema.json field-by-field so this test
// fails the moment the two drift, without adding a JSON Schema dependency to
// this package.
const envelopeSchema = JSON.parse(
  readFileSync(new URL('../../../../contracts/events/envelope.schema.json', import.meta.url), 'utf8')
) as { properties: Record<string, { pattern?: string }>; required: string[] };

function pattern(field: string): RegExp {
  const p = envelopeSchema.properties[field]?.pattern;
  if (!p) throw new Error(`envelope.schema.json: no pattern for ${field}`);
  return new RegExp(p);
}

describe('uuidv7', () => {
  it('matches the schema pattern for id (version 7, variant 10)', () => {
    for (let i = 0; i < 50; i++) expect(uuidv7()).toMatch(pattern('id'));
  });

  it('is lexicographically increasing across millisecond boundaries', async () => {
    const a = uuidv7();
    await new Promise((r) => setTimeout(r, 2));
    const b = uuidv7();
    expect(a < b).toBe(true);
  });
});

describe('buildEnvelope', () => {
  const tenantId = '01926f00-0000-7000-8000-000000000001';
  const contactId = '01926f3a-0000-7000-a000-00000000002a';

  it('produces every field required by the C1 envelope schema', () => {
    const envelope = buildEnvelope('core', 'contacts.upserted', tenantId, contactId, { ok: true });

    for (const field of envelopeSchema.required) {
      expect(envelope, `missing required field ${field}`).toHaveProperty(field);
    }
    expect(envelope.id).toMatch(pattern('id'));
    expect(envelope.type).toMatch(pattern('type'));
    expect(envelope.tenant_id).toMatch(pattern('tenant_id'));
    expect(envelope.occurred_at).toMatch(pattern('occurred_at'));
    expect(envelope.source).toMatch(pattern('source'));
    expect(envelope.contact_id).toMatch(pattern('contact_id'));
    expect(envelope.schema_version).toBe(1);
    expect(envelope.data).toEqual({ ok: true });
  });

  it('allows a null contact_id', () => {
    const envelope = buildEnvelope('core', 'system.audit.recorded', tenantId, null, {});
    expect(envelope.contact_id).toBeNull();
  });

  it('sets trace_parent only inside an active span', () => {
    const envelope = buildEnvelope('core', 'contacts.upserted', tenantId, null, {});
    expect(envelope.trace_parent).toBeUndefined();
  });
});

describe('subjectFor', () => {
  it('builds oe.<type>.<tenant_id>', () => {
    expect(subjectFor('behavior.tracked', '0192')).toBe('oe.behavior.tracked.0192');
  });
});
