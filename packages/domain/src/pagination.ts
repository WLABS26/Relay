import { z } from 'zod';
import { AppError } from './errors';
import { isUuid } from './ids';

/**
 * Stable keyset pagination on (created_at, id). Cursors are opaque base64url JSON. Lists are
 * ordered newest first: the next page holds rows strictly "less than" the cursor.
 */
export interface Cursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id]), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      !Number.isNaN(Date.parse(parsed[0])) &&
      isUuid(parsed[1])
    ) {
      return { createdAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through
  }
  throw new AppError('validation_failed', 'Invalid pagination cursor', {
    fieldErrors: { cursor: ['Invalid cursor'] },
  });
}

export const pageQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
