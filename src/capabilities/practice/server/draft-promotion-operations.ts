import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { DraftForceEnableBodySchema } from '../api/draft-moderation-contracts';
import type { RunTaskFn } from '../jobs/quiz_verify';
import { verifyAndPromote } from './quiz/verify-and-promote';

export async function enablePracticeDraft(db: Db, params: Record<string, string>) {
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

  return {
    promoted: result.promoted,
    status: result.status,
    verify_event_id: result.verifyEventId ?? null,
    reason: result.reason ?? null,
  };
}

// The override branch never consults runTaskFn (no AI on force-enable), but the gate
// signature requires it; a throwing stub makes any accidental dispatch loud rather
// than silently hitting the network.
const noRunTask: RunTaskFn = async () => {
  throw new Error('force-enable must not dispatch a verify task (override skips AI)');
};

export async function forceEnablePracticeDraft(
  db: Db,
  params: Record<string, string>,
  readBody: () => Promise<unknown>,
) {
  const id = (params.id ?? '').trim();
  if (!id) {
    throw new ApiError('validation_error', 'question id is required', 400);
  }

  const raw = await readBody().catch(() => null);
  const parsed = DraftForceEnableBodySchema.safeParse(raw);
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

  return {
    promoted: result.promoted,
    status: result.status,
    verify_event_id: result.verifyEventId ?? null,
    reason: result.reason ?? null,
  };
}
