import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from './index.js';

describe('loadConfig', () => {
  const schema = z.object({
    PORT: z.coerce.number().int().positive(),
    DATABASE_URL: z.string().url(),
  });

  it('parses and coerces a valid env', () => {
    const config = loadConfig(schema, {
      PORT: '3000',
      DATABASE_URL: 'postgres://localhost:5432/oe',
    });
    expect(config).toEqual({ PORT: 3000, DATABASE_URL: 'postgres://localhost:5432/oe' });
  });

  it('throws a readable error listing every failing field', () => {
    expect(() => loadConfig(schema, { PORT: 'nope' })).toThrowError(
      /PORT.*\n.*DATABASE_URL/s
    );
  });
});
