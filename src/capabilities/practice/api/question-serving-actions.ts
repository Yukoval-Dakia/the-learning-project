// YUK-1514 — POST /api/questions/[id]/serving-actions/[command]
// Command surface for releasing a held question (serving-holds UI contract v2).
//
//   reverify            async — re-enqueue the admission run through #1752's
//                        mechanism (paid-effect claim never re-pays an
//                        identical already-paid base)
//   recheck_source      async — re-dispatch source_verify onto the queue the
//                        verify-dispatch outbox drains to
//   release_verify_hold sync  — clear verify_hold via the publisher's
//                        dimension-only path; never touches retraction_hold,
//                        never mints a revision
//
// Every command requires an Idempotency-Key header and returns
// {accepted, serving} where serving is the same projection the list/detail
// reads emit. accepted=false when the command does not apply to the current
// hold (a replay of a rejected command is still idempotent).
//
// Auth is enforced upstream by middleware (x-internal-token); the handler
// mirrors the sibling question routes (zod, ApiError, errorResponse).

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { runServingAction } from '../server/serving-actions';
import { QuestionServingActionParamsSchema } from './question-solve-contracts';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsedParams = QuestionServingActionParamsSchema.safeParse(params);
    if (!parsedParams.success) {
      throw new ApiError(
        'validation_error',
        'expected /api/questions/[id]/serving-actions/[reverify|recheck_source|release_verify_hold]',
        400,
      );
    }
    const idempotencyKey = req.headers.get('idempotency-key')?.trim();
    if (!idempotencyKey) {
      throw new ApiError('validation_error', 'Idempotency-Key header is required', 400);
    }
    if (idempotencyKey.length > 200) {
      throw new ApiError('validation_error', 'Idempotency-Key exceeds 200 characters', 400);
    }

    const result = await runServingAction(db, {
      questionId: parsedParams.data.id,
      command: parsedParams.data.command,
      idempotencyKey,
    });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
