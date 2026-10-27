import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { QuestionServingActionParamsSchema } from '../api/question-solve-contracts';
import { runServingAction } from './serving-actions';

export async function runPracticeServingAction(
  db: Db,
  params: Record<string, string>,
  rawIdempotencyKey: string | null,
) {
  const parsedParams = QuestionServingActionParamsSchema.safeParse(params);
  if (!parsedParams.success) {
    throw new ApiError(
      'validation_error',
      'expected /api/questions/[id]/serving-actions/[reverify|recheck_source|release_verify_hold]',
      400,
    );
  }
  const idempotencyKey = rawIdempotencyKey?.trim();
  if (!idempotencyKey) {
    throw new ApiError('validation_error', 'Idempotency-Key header is required', 400);
  }
  if (idempotencyKey.length > 200) {
    throw new ApiError('validation_error', 'Idempotency-Key exceeds 200 characters', 400);
  }

  return runServingAction(db, {
    questionId: parsedParams.data.id,
    command: parsedParams.data.command,
    idempotencyKey,
  });
}
