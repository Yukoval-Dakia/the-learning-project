import type { ZodType } from 'zod';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import {
  CreateHintRequestBodySchema,
  CreateSolveSessionBodySchema,
  HintRequestBodySchema,
  StartSolveBodySchema,
} from '../api/question-solve-contracts';
import { SolveError, planSolveHintOutcome, startSolveSession } from './solve-session';

function parseResourceInput<T>(raw: unknown, schema: ZodType<T>): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      'validation_error',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      400,
    );
  }
  return parsed.data;
}

export async function createPracticeSolveSession(db: Db, raw: unknown) {
  const { question_id: questionId, ...body } = parseResourceInput(
    raw,
    CreateSolveSessionBodySchema,
  );
  return startPracticeSolveSession(db, questionId, body);
}

export async function createPracticeHintRequest(db: Db, sessionId: string, raw: unknown) {
  const { question_id: questionId, ...body } = parseResourceInput(raw, CreateHintRequestBodySchema);
  return requestPracticeSolveHint(db, questionId, sessionId, body);
}

export async function startPracticeSolveSession(db: Db, questionId: string, raw: unknown) {
  try {
    const parsed = StartSolveBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        400,
      );
    }

    const result = await startSolveSession({
      db,
      questionId,
      issuanceId: parsed.data?.issuance_id,
    });

    return {
      session_id: result.sessionId,
      ...(parsed.data?.issuance_id
        ? {
            evaluation_group_id: `solve_${result.sessionId}`,
            idempotency_key: `solve_${result.sessionId}`,
          }
        : {}),
      issuance_id: parsed.data?.issuance_id,
    };
  } catch (err) {
    if (err instanceof SolveError && err.code === 'question_not_found') {
      throw new ApiError('not_found', err.message, 404);
    }
    throw err;
  }
}

export async function requestPracticeSolveHint(
  db: Db,
  questionId: string,
  sessionId: string,
  raw: unknown,
) {
  try {
    const parsed = HintRequestBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        400,
      );
    }
    const hintIndex = parsed.data ? parsed.data.hint_index : 0;

    // generation failures resolve to typed fallback/unavailable
    // help instead of an upstream 502; session/state errors keep their status.
    const outcome = await planSolveHintOutcome({
      db,
      sessionId,
      hintIndex,
      expectedQuestionId: questionId,
      issuanceId: parsed.data?.issuance_id,
    });
    const hintRequestId = newId();
    await writeEvent(db, {
      id: hintRequestId,
      session_id: sessionId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:hint_request',
      subject_kind: 'question',
      subject_id: questionId,
      outcome: outcome.status === 'ok' ? 'success' : 'failure',
      payload: {
        hint_index: hintIndex,
        ...(outcome.status === 'ok'
          ? {}
          : {
              status: outcome.status,
              reason: outcome.reason,
              ...(outcome.status === 'fallback' ? { help_kind: outcome.help.kind } : {}),
            }),
      },
    });
    if (outcome.status === 'ok') {
      return { hint_request_id: hintRequestId, text_md: outcome.text_md };
    }
    return { hint_request_id: hintRequestId, ...outcome };
  } catch (err) {
    if (err instanceof SolveError) {
      if (err.code === 'session_not_found' || err.code === 'question_not_found') {
        throw new ApiError('not_found', err.message, 404);
      }
      if (err.code === 'session_not_active') {
        throw new ApiError('conflict', err.message, 409);
      }
      if (err.code === 'llm_parse_failed') {
        throw new ApiError('upstream_error', err.message, 502);
      }
    }
    throw err;
  }
}
