import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { restoreQuestion } from '@/server/questions/write';
import { QuestionParamsSchema, RestoreQuestionBodySchema } from '../api/question-solve-contracts';

export async function restorePracticeQuestion(
  db: Db,
  params: Record<string, string>,
  readBody: () => Promise<unknown>,
) {
  const parsedParams = QuestionParamsSchema.safeParse(params);
  if (!parsedParams.success) {
    throw new ApiError('validation_error', 'question id is required', 400);
  }
  const id = parsedParams.data.id;

  const raw = await readBody().catch(() => null);
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

  return { ok: true, restored: true, event_id: result.event_id } as const;
}
