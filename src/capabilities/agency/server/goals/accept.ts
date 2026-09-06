// YUK-143 / ADR-0025 — North-Star goal_scope accept materializer (Wave-9 core).
//
// Accepting a `goal_scope` proposal materializes the `goal` row + writes the
// `rate` (rating='accept') event in one transaction (evidence-first). The goal
// id is the proposal's `target.subject_id` (reserved by runGoalScopeAndWrite),
// so accept is deterministic + idempotent. The user may have edited the
// proposal's proposed_change before accepting (W10 inbox UI) — we read scope /
// title / sequence_hint straight off the (possibly edited) proposed_change.
//
// dismiss is handled by the generic rate-event path in actions.ts (no row to
// materialize). retract tombstones the goal to 'dormant' (see actions.ts).

import { and, eq } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import type { ProposalInboxRow } from '@/kernel/proposals/inbox';
import { resolveKnownSubjectId } from '@/subjects/profile';
import { materializeAcceptedGoal } from './commands';

export interface GoalScopeAcceptResult {
  kind: 'goal_scope';
  rate_event_id: string;
  goal_id: string;
  idempotent?: boolean;
}

interface GoalScopeChange {
  title?: unknown;
  subject_id?: unknown;
  scope_knowledge_ids?: unknown;
  sequence_hint?: unknown;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export async function acceptGoalScopeProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: { user_note?: string } = {},
): Promise<GoalScopeAcceptResult> {
  const change = proposal.payload.proposed_change as GoalScopeChange;
  const title = typeof change.title === 'string' && change.title.length > 0 ? change.title : null;
  if (!title) {
    throw new ApiError(
      'validation_error',
      `goal_scope proposal ${proposalId} is missing proposed_change.title`,
      400,
    );
  }
  // The goal id was reserved as the proposal target.subject_id by the producer.
  const goalId = proposal.target.subject_id;
  if (!goalId) {
    throw new ApiError(
      'validation_error',
      `goal_scope proposal ${proposalId} has no target.subject_id (reserved goal id)`,
      400,
    );
  }
  // YUK-600（阻断④防线步 1，accept 侧）：alias→canonical 归一；unknown →
  // **null 回退 + warn**（proposal 不因打字错报废——与 goal-create 的 422 分岔
  // 是有意差别：这里没有可回显的 client）。canonical 即 subjectId 变量本身，
  // 全部下游（rate snapshot / insertGoal / fold）自动收口。
  const rawSubjectId =
    typeof change.subject_id === 'string' && change.subject_id.length > 0
      ? change.subject_id
      : null;
  const subjectId = rawSubjectId ? resolveKnownSubjectId(rawSubjectId) : null;
  if (rawSubjectId && !subjectId) {
    console.warn('[goal-accept] unknown subject in proposal — degrading to subject-less goal', {
      proposalId,
      rawSubjectId,
    });
  }
  const scopeKnowledgeIds = stringArray(change.scope_knowledge_ids);
  const sequenceHint =
    typeof change.sequence_hint === 'number' && Number.isFinite(change.sequence_hint)
      ? change.sequence_hint
      : 0;

  // Idempotency: an accept rate event already exists → goal row is materialized.
  const existingRate = (
    await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)))
      .limit(1)
  )[0];
  if (existingRate) {
    const ratePayload = existingRate.payload as { rating?: string };
    if (ratePayload.rating !== 'accept') {
      throw new ApiError(
        'conflict',
        `proposal ${proposalId} already decided as ${ratePayload.rating}`,
        409,
      );
    }
    return {
      kind: 'goal_scope',
      rate_event_id: existingRate.id,
      goal_id: goalId,
      idempotent: true,
    };
  }

  const now = new Date();
  const rateEventId = newId();
  await db.transaction(async (tx) => {
    // 1. The accept `rate` event — written FIRST so the goal fold (when the flag is ON) sees
    //    the chained accept in the same tx and projects status='active'.
    await writeEvent(tx, {
      id: rateEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: proposalId,
      outcome: 'success',
      payload: {
        rating: 'accept',
        materialized_goal_id: goalId,
        ...(opts.user_note ? { user_note: opts.user_note } : {}),
      },
      caused_by_event_id: proposalId,
      created_at: now,
    });
    await materializeAcceptedGoal(tx, {
      id: goalId,
      title,
      subject_id: subjectId,
      scope_knowledge_ids: scopeKnowledgeIds,
      sequence_hint: sequenceHint,
      proposalId,
      now,
    });
  });

  return { kind: 'goal_scope', rate_event_id: rateEventId, goal_id: goalId };
}
