import type { Db } from '@/db/client';
import { ApiError, collectionPayload } from '@/kernel/http';
import { getPracticeList } from './practice-read';

function parseLimit(value: string | null): number {
  if (value === null) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ApiError('validation_error', `invalid limit: ${value}`, 400);
  }
  return Math.min(parsed, 200);
}

// Shared paper-list request and response contract; aggregation stays in practice-read.
export async function readPaperList(
  db: Db,
  query: { limit: string | null; cursor: string | null } = { limit: null, cursor: null },
) {
  const limit = parseLimit(query.limit);
  const result = await getPracticeList(db, {
    limit,
    cursor: query.cursor ?? undefined,
  });
  return collectionPayload(result.papers, { limit, next_cursor: result.next_cursor }, result);
}
