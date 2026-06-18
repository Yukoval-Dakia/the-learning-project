// YUK-402 inc-4a — POST /api/review/drafts/[id]/force-enable: owner manual gate,
// override (skip verify) promote path.
//
// docs/superpowers/specs/2026-06-18-inc4-owner-manual-gate-design.md §2.
//
// Owner force-enable: skip the AI verify and promote directly, evidence-first —
// requires a non-empty `reason` (留痕). verifyAndPromote's override branch writes
// actor_kind:'user' + skipped_verify:true + reason and enforces the YUK-400 B-section
// guards (only raw-pool-promotable sources / true drafts / non-archived KC /
// non-soft-archived drafts may be force-promoted). Auth is enforced upstream by the
// /api/* internal-token middleware.

import { z } from 'zod';

import { db } from '@/db/client';
import type { RunTaskFn } from '@/server/boss/handlers/quiz_verify';
import { ApiError, errorResponse } from '@/server/http/errors';
import { verifyAndPromote } from '@/server/quiz/verify-and-promote';

// The override branch never consults runTaskFn (no AI on force-enable), but the gate
// signature requires it; a throwing stub makes any accidental dispatch loud rather
// than silently hitting the network.
const noRunTask: RunTaskFn = async () => {
  throw new Error('force-enable must not dispatch a verify task (override skips AI)');
};

const Body = z.object({ reason: z.string().trim().min(1) });

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const id = (params.id ?? '').trim();
    if (!id) {
      throw new ApiError('validation_error', 'question id is required', 400);
    }

    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError('validation_error', 'reason is required (non-empty)', 400);
    }

    const result = await verifyAndPromote({
      db,
      questionId: id,
      runTaskFn: noRunTask,
      actor: { kind: 'user', ref: 'self' },
      skipVerify: { reason: parsed.data.reason },
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
