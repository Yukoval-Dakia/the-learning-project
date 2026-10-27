import type { Db } from '@/db/client';
import { ApiError, collectionPayload } from '@/kernel/http';
import { DraftReviewListQuerySchema } from '../api/draft-moderation-contracts';
import { listDraftReview } from './draft-review';

const MAX_LIMIT = 200;

export async function readPracticeDraftList(db: Db, sp: URLSearchParams) {
  const parsed = DraftReviewListQuerySchema.safeParse({
    source: sp.get('source') ?? undefined,
    kind: sp.get('kind') ?? undefined,
    limit: sp.get('limit') ?? undefined,
    offset: sp.get('offset') ?? undefined,
    cursor: sp.get('cursor') ?? undefined,
  });
  if (!parsed.success) {
    throw new ApiError(
      'validation_error',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      400,
    );
  }
  const q = parsed.data;
  if (q.cursor && sp.has('offset')) {
    throw new ApiError('invalid_cursor', 'cursor and offset are mutually exclusive', 400);
  }
  const limit = Math.min(Math.max(q.limit, 1), MAX_LIMIT);
  const offset = Math.max(q.offset, 0);

  const page = await listDraftReview(db, {
    source: q.source,
    kind: q.kind,
    limit,
    offset,
    cursor: q.cursor,
  });

  return collectionPayload(page.rows, { limit, next_cursor: page.next_cursor }, page);
}
