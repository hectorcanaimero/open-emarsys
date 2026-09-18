import { BadRequestException } from '@nestjs/common';

export interface CursorPage<T> {
  items: T[];
  next_cursor: string | null;
}

export interface CursorQuery {
  cursor?: string;
  limit: number;
}

/** Parses `?cursor&limit` (C3 pagination), clamping `limit` to `[1, maxLimit]`. */
export function parseCursorQuery(
  query: Record<string, unknown>,
  { defaultLimit = 20, maxLimit = 100 }: { defaultLimit?: number; maxLimit?: number } = {}
): CursorQuery {
  const rawLimit = query.limit;
  let limit = defaultLimit;
  if (typeof rawLimit === 'string' && rawLimit.trim() !== '') {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new BadRequestException('limit must be a positive integer');
    }
    limit = Math.min(parsed, maxLimit);
  }
  const cursor = typeof query.cursor === 'string' && query.cursor.length > 0 ? query.cursor : undefined;
  return { cursor, limit };
}

/** Builds the `{items, next_cursor}` page body (C3 pagination). */
export function buildCursorPage<T>(items: T[], nextCursor: string | null): CursorPage<T> {
  return { items, next_cursor: nextCursor };
}
