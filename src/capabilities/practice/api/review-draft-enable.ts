// YUK-402 inc-4a — POST /api/review/drafts/[id]/enable: owner manual gate, normal
// verify → promote path.
//
// docs/superpowers/specs/2026-06-18-inc4-owner-manual-gate-design.md §2.
//
// Runs the B5 verify (reuses the per-source quiz_verify/source_verify handler via
// the caller-agnostic verifyAndPromote gate) and promotes on pass; on not-pass
// returns the tri-state verdict (needs_review / failed + reason). actor='user' tags
// the gate's verify event as owner-driven. Auth is enforced upstream by the /api/*
// internal-token middleware.

import { db } from '@/db/client';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { ApiError, errorResponse } from '@/server/http/errors';
import { verifyAndPromote } from '@/server/quiz/verify-and-promote';

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
