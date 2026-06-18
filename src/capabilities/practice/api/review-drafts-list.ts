// YUK-402 inc-4a — GET /api/review/drafts: owner manual gate draft-review pool.
//
// docs/superpowers/specs/2026-06-18-inc4-owner-manual-gate-design.md §2.
//
// Lists draft_status='draft' questions (excluding soft-archived drafts) with a
// per-draft verify status derived from the latest terminal verify event. Auth is
// enforced upstream by the /api/* internal-token middleware; the handler mirrors
// the sibling list routes (zod safeParse, clamp, errorResponse).

import { z } from 'zod';

import { listDraftReview } from '@/capabilities/practice/server/draft-review';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const ListQuerySchema = z.object({
  source: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  limit: z.coerce.number().int().default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const sp = url.searchParams;

    const parsed = ListQuerySchema.safeParse({
      source: sp.get('source') ?? undefined,
      kind: sp.get('kind') ?? undefined,
      limit: sp.get('limit') ?? undefined,
      offset: sp.get('offset') ?? undefined,
    });
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const q = parsed.data;
    const limit = Math.min(Math.max(q.limit, 1), MAX_LIMIT);
    const offset = Math.max(q.offset, 0);

    const page = await listDraftReview(db, {
      source: q.source,
      kind: q.kind,
      limit,
      offset,
    });

    return Response.json(page);
  } catch (err) {
    return errorResponse(err);
  }
}
