// POST /api/review/drafts/[id]/enable: owner manual gate, normal verify → promote.
//
// verifyAndPromote reuses the per-source quiz_verify/source_verify handler and
// promotes on pass; otherwise it returns the tri-state verdict
// (needs_review / failed + reason). actor='user' marks the verify event as
// owner-driven. Auth is enforced upstream by the /api/* internal-token middleware.

import { verifyAndPromote } from '@/capabilities/practice/server/quiz/verify-and-promote';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { makeRunTaskFn } from '@/server/ai/runner-fn';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const id = (params.id ?? '').trim();
    if (!id) {
      throw new ApiError('validation_error', 'question id is required', 400);
    }

    const result = await verifyAndPromote({
      db,
      questionId: id,
      runTaskFn: makeRunTaskFn(db),
      actor: { kind: 'user', ref: 'self' },
    });

    if (result.status === 'skipped:not_found') {
      throw new ApiError('not_found', `question ${id} not found`, 404);
    }

    return Response.json({
      promoted: result.promoted,
      status: result.status,
      verify_event_id: result.verifyEventId ?? null,
      reason: result.reason ?? null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
