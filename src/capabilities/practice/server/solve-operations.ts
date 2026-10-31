import type { ZodType } from 'zod';
import { readHelpLatency } from '@/ai/help-latency';
import { type SealedHelpExplanationReplay, readReplyGrounding } from '@/ai/help-reply-grounding';
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

export async function persistHelpExplanationReplay(
  db: Db,
  input: {
    sessionId?: string | null;
    subjectKind: string;
    subjectId: string;
    replay: SealedHelpExplanationReplay;
  },
): Promise<void> {
  await writeEvent(db, {
    id: `help_explanation_${newId()}`,
    session_id: input.sessionId ?? null,
    actor_kind: 'agent',
    actor_ref: 'agent:copilot',
    action: 'experimental:help_explanation_replay',
    subject_kind: input.subjectKind,
    subject_id: input.subjectId,
    outcome: input.replay.verdict === 'fail' ? 'failure' : 'success',
    payload: { reply_grounding: input.replay },
    task_run_id: input.replay.task_run_id,
  });
}

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
    const replyGrounding = outcome.status === 'ok' ? outcome.reply_grounding : undefined;
    const { help_latency: helpLatency, ...publicOutcome } = outcome;
    const denominator = helpLatency ? readHelpLatency([helpLatency]).denominator : undefined;
    const reply_grounding = readReplyGrounding(replyGrounding);
    await writeEvent(db, {
      id: hintRequestId,
      session_id: sessionId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:hint_request',
      subject_kind: 'question',
      subject_id: questionId,
      outcome: publicOutcome.status === 'ok' ? 'success' : 'failure',
      payload: {
        hint_index: hintIndex,
        ...(helpLatency && denominator ? { help_latency: helpLatency, denominator } : {}),
        ...(reply_grounding ? { reply_grounding } : {}),
        ...(publicOutcome.status === 'ok'
          ? {}
          : {
              status: publicOutcome.status,
              reason: publicOutcome.reason,
              ...(publicOutcome.stop_retry ? { stop_retry: publicOutcome.stop_retry.retry } : {}),
              ...(publicOutcome.status === 'fallback'
                ? { help_kind: publicOutcome.help.kind }
                : {}),
            }),
      },
    });
    if (publicOutcome.status === 'ok') {
      return { hint_request_id: hintRequestId, text_md: publicOutcome.text_md };
    }
    return { hint_request_id: hintRequestId, ...publicOutcome };
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
