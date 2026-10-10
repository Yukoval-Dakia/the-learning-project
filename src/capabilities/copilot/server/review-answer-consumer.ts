import { and, eq, sql } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import type { Db, Tx } from '@/db/client';
import { event, job_events, learning_session } from '@/db/schema';
import { eventCorrectionLockKey, getCorrectionStatus } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import type { ToolContext } from '@/kernel/tools/types';
import { acquireCopilotExecutionSettlementLock } from './copilot-run-coordination';
import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
  hasCancelRequest,
  isCopilotRunTerminalEvent,
} from './copilot-run-status';
import { BoundReviewAnswerSchema, consumeReviewAnswerBinding } from './practice-port';

/** Rebuild only the current accepted ask's binding. Never use a model-selected event. */
export async function resolveCopilotReviewAnswer(
  database: Db,
  input: {
    sessionId: string;
    sourceEventId: string;
    signal: AbortSignal;
  },
): Promise<ToolContext['reviewAnswer']> {
  const [ask] = await database
    .select()
    .from(event)
    .where(
      and(
        eq(event.id, input.sourceEventId),
        eq(event.session_id, input.sessionId),
        eq(event.action, 'experimental:copilot_user_ask'),
        eq(event.actor_kind, 'user'),
        eq(event.actor_ref, 'user:self'),
      ),
    );
  if (!ask?.payload.review_answer) return undefined;
  const binding = BoundReviewAnswerSchema.parse(ask.payload.review_answer);
  if (binding.original_ref !== ask.id || binding.session_id !== input.sessionId) {
    throw new ApiError('review_answer_unbound', 'original belongs to another turn/session', 403);
  }
  const authorize = async (tx: Tx, signal: AbortSignal) => {
    // Stop uses this same lock. Correct writers use the same target lock.
    await acquireCopilotExecutionSettlementLock(tx, input.sourceEventId);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${eventCorrectionLockKey(input.sourceEventId)}, 0))`,
    );
    const [current] = await tx.select().from(event).where(eq(event.id, ask.id));
    if (
      !current ||
      current.session_id !== input.sessionId ||
      current.actor_kind !== 'user' ||
      current.actor_ref !== 'user:self' ||
      current.action !== 'experimental:copilot_user_ask' ||
      JSON.stringify(BoundReviewAnswerSchema.parse(current.payload.review_answer)) !==
        JSON.stringify(binding)
    ) {
      throw new ApiError('review_original_modified', 'accepted original changed', 409);
    }
    if ((await getCorrectionStatus(tx, ask.id)).state !== 'active') {
      throw new ApiError('review_authorization_revoked', 'accepted ask is no longer active', 409);
    }
    const [session] = await tx
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, input.sessionId))
      .for('share');
    if (session?.type !== 'conversation' || !['active', 'idle'].includes(session.status)) {
      throw new ApiError('review_authorization_revoked', 'conversation is no longer open', 409);
    }
    if (binding.original.review_session_id) {
      const [review] = await tx
        .select()
        .from(learning_session)
        .where(eq(learning_session.id, binding.original.review_session_id))
        .for('share');
      if (review?.type !== 'review' || review.status !== 'started') {
        throw new ApiError(
          'review_authorization_revoked',
          'review session is no longer active',
          409,
        );
      }
    }
    const events = await tx
      .select({ event_type: job_events.event_type, payload: job_events.payload })
      .from(job_events)
      .where(
        and(eq(job_events.business_table, COPILOT_RUN_TABLE), eq(job_events.business_id, ask.id)),
      );
    if (
      !events.some(
        (e) =>
          e.event_type === COPILOT_RUN_EVENTS.QUEUED &&
          e.payload.session_id === input.sessionId &&
          e.payload.review_answer_sha256 === binding.original_sha256 &&
          e.payload.review_answer_binding_sha256 === canonicalHash(binding),
      )
    ) {
      throw new ApiError('review_answer_unbound', 'original has no accepted chat run', 403);
    }
    if (hasCancelRequest(events) || events.some(isCopilotRunTerminalEvent)) {
      throw new ApiError('review_authorization_revoked', 'chat run was cancelled or settled', 409);
    }
    const [clock] = await tx.execute<{ now_ms: number }>(
      sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::double precision AS now_ms`,
    );
    if (
      typeof clock?.now_ms !== 'number' ||
      !Number.isFinite(clock.now_ms) ||
      clock.now_ms >= Date.parse(binding.expires_at)
    ) {
      throw new ApiError('review_authorization_expired', 'submission permission has expired', 409);
    }
    signal.throwIfAborted();
  };
  return {
    originalRef: binding.original_ref,
    sessionId: input.sessionId,
    submit: (toolSignal) => {
      const signal = toolSignal ? AbortSignal.any([input.signal, toolSignal]) : input.signal;
      return consumeReviewAnswerBinding(database, binding, {
        authorize: (tx) => authorize(tx, signal),
        signal,
      });
    },
  };
}
