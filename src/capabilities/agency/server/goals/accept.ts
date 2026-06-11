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
import { event, goal } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { ApiError } from '@/server/http/errors';
import type { ProposalInboxRow } from '@/server/proposals/inbox';
import { insertGoal } from './queries';

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
  const subjectId =
    typeof change.subject_id === 'string' && change.subject_id.length > 0
      ? change.subject_id
      : null;
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
    await insertGoal(tx, {
      id: goalId,
      title,
      subject_id: subjectId,
      scope_knowledge_ids: scopeKnowledgeIds,
      sequence_hint: sequenceHint,
      status: 'active',
      source: 'goal_scope_proposal',
      source_ref: proposalId,
      now,
    });
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
  });

  return { kind: 'goal_scope', rate_event_id: rateEventId, goal_id: goalId };
}
