// Accepting a `goal_scope` proposal materializes the `goal` row and writes the `rate`
// (rating='accept') event in the kernel decision transaction. The goal id is the proposal's
// `target.subject_id` (reserved by the producer), so accept is deterministic and
// idempotent. Scope/title/sequence_hint are read off the possibly edited proposed_change.
//
// dismiss writes only the rate event (agency dismiss applier, same decision lock as this
// accept). retract tombstones the goal to 'dormant' (proposal-retract-goal.ts).

import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import {
  type ProposalAcceptEffectOutcome,
  type RecordedProposalRate,
  runProposalAccept,
} from '@/kernel/proposals/decision-protocol';
import type { ProposalInboxRow } from '@/kernel/proposals/inbox';
import { materializeAcceptedGoal } from '@/kernel/records/goal-commands';
import { resolveKnownSubjectId } from '@/subjects/profile';

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
  // alias→canonical 归一；unknown → **null 回退 + warn**（proposal 不因打字错报废——与
  // goal-create 的 422 是有意差别：这里没有可回显的 client）。canonical 即 subjectId，
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

  // A recorded accept means the goal row is already materialized.
  const { result } = await runProposalAccept(db, proposalId, {
    proposal,
    userNote: opts.user_note,
    signal: 'after_commit',
    replay: async (rate: RecordedProposalRate): Promise<GoalScopeAcceptResult> => ({
      kind: 'goal_scope',
      rate_event_id: rate.id,
      goal_id: goalId,
      idempotent: true,
    }),
    effect: async ({
      tx,
      writeRate,
    }): Promise<ProposalAcceptEffectOutcome<GoalScopeAcceptResult>> => {
      const now = new Date();
      // Write the accept `rate` event FIRST so the goal fold sees the chained accept in
      // the same tx and projects status='active'.
      const rateEventId = await writeRate({
        created_at: now,
        payload: { materialized_goal_id: goalId },
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
      return {
        status: 'accepted',
        result: { kind: 'goal_scope', rate_event_id: rateEventId, goal_id: goalId },
      };
    },
  });
  return result;
}
