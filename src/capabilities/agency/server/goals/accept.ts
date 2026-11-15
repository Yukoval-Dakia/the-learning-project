// Accepting a `goal_scope` proposal materializes the `goal` row and writes the `rate`
// (rating='accept') event in the kernel decision transaction. The goal id is the proposal's
// `target.subject_id` (reserved by the producer), so accept is deterministic and
// idempotent. Scope/title/sequence_hint are read off the possibly edited proposed_change.
//
// dismiss writes only the rate event (agency dismiss applier, same decision lock as this
// accept). retract tombstones the goal to 'dormant' (proposal-retract-goal.ts).

import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import type { ProposalCorrectedPayload } from '@/kernel/proposals';
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
  ordered_scope?: unknown;
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
  opts: { user_note?: string; corrected_payload?: ProposalCorrectedPayload } = {},
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

  // YUK-2124 — a learner may reorder the path in the inbox. When ordered_scope
  // is present it is the canonical per-point order: persist scope_knowledge_ids
  // in that order (jsonb array order is the durable path). A present-but-
  // malformed ordered_scope (does not cover the confirmed set exactly, or has
  // duplicate/foreign ids) is a fail-closed reject, matching the producer's
  // own validation — never silently degrade to the unordered set.
  const scopeSet = new Set(scopeKnowledgeIds);
  const ordered = Array.isArray(change.ordered_scope) ? change.ordered_scope : [];
  const orderedIds = ordered
    .map((p) =>
      p && typeof p === 'object' ? (p as { knowledge_id?: unknown }).knowledge_id : null,
    )
    .filter((id): id is string => typeof id === 'string');
  if (ordered.length > 0) {
    const coversExactly =
      orderedIds.length === scopeKnowledgeIds.length &&
      orderedIds.every((id) => scopeSet.has(id)) &&
      new Set(orderedIds).size === orderedIds.length;
    if (!coversExactly) {
      throw new ApiError(
        'validation_error',
        `goal_scope proposal ${proposalId} has an ordered_scope that does not cover the confirmed scope exactly`,
        400,
      );
    }
  }
  const materializedScope = ordered.length > 0 ? orderedIds : scopeKnowledgeIds;

  // Learner edit (corrected_payload.goal_scope): the learner may remove points
  // or reorder the proposed path before accepting. The edit is fail-closed —
  // it must be a non-empty subset of the proposed scope ids with no foreign or
  // duplicate ids — then its array order becomes the materialized learn order.
  // An absent goal_scope edit materializes the stored proposal unchanged.
  const corrected = opts.corrected_payload?.goal_scope;
  const finalScope = (() => {
    // Owner-specific fail-closed: a corrected_payload that reaches the goal
    // owner without a goal_scope variant is a foreign-owner edit smuggled into
    // this accept — reject it rather than silently materialize an uncorrected
    // scope (the schema's exactly-one refine already guards the wire; this
    // guards internal callers that bypass it).
    if (opts.corrected_payload !== undefined && corrected === undefined) {
      throw new ApiError(
        'validation_error',
        `goal_scope accept requires corrected_payload.goal_scope`,
        400,
      );
    }
    if (corrected === undefined) return materializedScope;
    const edited = stringArray(corrected.ordered_knowledge_ids as unknown);
    if (
      edited.length === 0 ||
      new Set(edited).size !== edited.length ||
      edited.some((id) => !scopeSet.has(id))
    ) {
      throw new ApiError(
        'validation_error',
        `goal_scope corrected scope must be a non-empty subset of the proposed knowledge ids`,
        400,
      );
    }
    return edited;
  })();

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
        // Persist the materialized (possibly learner-edited) ordered scope on the
        // rate payload so the fold replays exactly what was accepted — the row
        // and the projection stay equal when a corrected order/subset was chosen.
        payload: { materialized_goal_id: goalId, materialized_scope: finalScope },
      });
      await materializeAcceptedGoal(tx, {
        id: goalId,
        title,
        subject_id: subjectId,
        scope_knowledge_ids: finalScope,
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
