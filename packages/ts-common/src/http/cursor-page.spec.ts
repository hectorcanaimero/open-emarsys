import { describe, expect, it } from 'vitest';
import { buildCursorPage, parseCursorQuery } from './cursor-page.js';

describe('cursor pagination (C3 ?cursor&limit -> {items, next_cursor})', () => {
  it('defaults limit and passes through cursor', () => {
    expect(parseCursorQuery({ cursor: 'abc' })).toEqual({ cursor: 'abc', limit: 20 });
  });

  it('clamps limit to maxLimit', () => {
    expect(parseCursorQuery({ limit: '9999' }, { maxLimit: 100 })).toEqual({
      cursor: undefined,
      limit: 100,
    });
  });

  it('rejects a non-positive limit', () => {
    expect(() => parseCursorQuery({ limit: '0' })).toThrow();
  });

  it('builds the page body with a null next_cursor on the last page', () => {
    expect(buildCursorPage([1, 2], null)).toEqual({ items: [1, 2], next_cursor: null });
  });
});
