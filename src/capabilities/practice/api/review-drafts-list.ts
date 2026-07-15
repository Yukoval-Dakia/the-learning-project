// YUK-402 inc-4a — GET /api/review/drafts: owner manual gate draft-review pool.
//
// docs/superpowers/specs/2026-06-18-inc4-owner-manual-gate-design.md §2.
//
// Lists draft_status='draft' questions (excluding soft-archived drafts) with a
// per-draft verify status derived from the latest terminal verify event. Auth is
// enforced upstream by the /api/* internal-token middleware; the handler mirrors
// the sibling list routes (zod safeParse, clamp, errorResponse).

import { listDraftReview } from '@/capabilities/practice/server/draft-review';
import { db } from '@/db/client';
import { collectionPayload } from '@/kernel/http';
import { ApiError, errorResponse } from '@/server/http/errors';
import { DraftReviewListQuerySchema } from './draft-moderation-contracts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const sp = url.searchParams;

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

    return Response.json(
      collectionPayload(page.rows, { limit, next_cursor: page.next_cursor }, page),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
