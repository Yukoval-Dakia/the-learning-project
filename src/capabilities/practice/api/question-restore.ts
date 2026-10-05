// YUK-1045 — POST /api/questions/[id]/restore: the restore (un-archive) write.
//
// Contract-layer counterpart of DELETE archive (§3.2「恢复要原子重新取得claim
// 并处理冲突」): un-tombstones a soft-archived question back to draft, clears the
// withdrawn lifecycle dimension, and atomically re-acquires the live dedup claim
// (the canonical_content_hash retained on metadata.archived_content_hash at
// archive time). Cascade-archived composite parts (archived_via_parent=this id)
// are restored with it; a claim conflict on ANY member rolls the whole restore
// back with 409 (no half-restored groups).
//
// Verify suspension is NOT lifted here — suspended groups stay suspended until
// a same-version re-verify passes (§3.3 suspension table).
//
// Auth is enforced upstream by middleware (x-internal-token); the handler
// mirrors the sibling DELETE's error mapping.

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { restoreQuestion } from '@/server/questions/write';
import { QuestionParamsSchema, RestoreQuestionBodySchema } from './question-solve-contracts';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsedParams = QuestionParamsSchema.safeParse(params);
    if (!parsedParams.success) {
      throw new ApiError('validation_error', 'question id is required', 400);
    }
    const id = parsedParams.data.id;

    const raw = await req.json().catch(() => null);
    const parsed = RestoreQuestionBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError('validation_error', 'body must be { version: non-negative integer }', 400);
    }

    const result = await restoreQuestion(db, id, parsed.data.version, 'self');
    if (result.status === 'not_found') {
      throw new ApiError('not_found', `question ${id} not found`, 404);
    }
    if (result.status === 'protected') {
      throw new ApiError(
        'immutable_question',
        'intervention diagnostic questions cannot be restored through the question bank',
        409,
      );
    }
    if (result.status === 'not_archived') {
      throw new ApiError('conflict', `question ${id} is not archived`, 409);
    }
    if (result.status === 'claim_conflict') {
      throw new ApiError(
        'conflict',
        `restore would collide with live question ${result.conflicting_question_id} holding the same content claim`,
        409,
      );
    }
    if (result.status === 'conflict') {
      throw new ApiError('conflict', `question ${id} concurrently modified`, 409);
    }

    return Response.json({ ok: true, restored: true, event_id: result.event_id });
  } catch (err) {
    return errorResponse(err);
  }
}
