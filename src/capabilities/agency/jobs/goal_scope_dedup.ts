// Station 2B / YUK-186 — goal_scope pending-proposal dedup scan.
//
// Modeled on loadPendingEdgeProposalKeys (propose_edge.ts:212-267) but adapted
// to the goal-proposal EVENT SHAPE, which differs from the edge proposal:
//   - A goal_scope proposal is written via writeAiProposal → eventShapeForProposal
//     DEFAULT branch (writer.ts:76-85): action='experimental:proposal',
//     subject_kind=payload.target.subject_kind='goal', and the proposal fields
//     are nested under payload.ai_proposal (NOT top-level like the edge's
//     from_knowledge_id). The candidate subject lives at
//     payload.ai_proposal.proposed_change.subject_id.
//
// The load-bearing divergence (FIX-1, BLOCKING): the chained-decision query keys
// ONLY on (action IN ('rate','correct'), caused_by_event_id IN proposeIds) — NO
// subject_kind filter. The goal accept path writes its rate event as
// subject_kind:'event' (accept.ts:121), dismiss/generic rate is ALSO
// subject_kind:'event' (writeGenericRateEvent, actions.ts), and the retract path
// writes a `correct` event with subject_kind:'event' (retractAiProposal,
// actions.ts:1782-1784). A subject_kind='goal' filter would match ZERO rows → an
// already-decided goal_scope propose mis-reads as still-pending → that subject is
// permanently locked out of re-propose. caused_by_event_id uniquely links the
// decision back to its propose (accept.ts:129), so it alone is the correct,
// sufficient join key.
//
// FIX-3: a retract writes a `correct` event (inbox status → stale) and NO `rate`
// (retractAiProposal, actions.ts:1778-1793). So a propose is "still pending" only
// if it has NEITHER a chained `rate` NOR a chained `correct`. Without the
// `correct` arm, a retracted/stale goal_scope keeps its subject pending forever →
// the cron permanently skipped_pending for that subject.

import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { event } from '@/db/schema';

/** YUK-187 — dismiss 冷却窗：被 dismiss 的 goal_scope 候选在该窗口内不再重提（「回来又消失」churn）。 */
export const GOAL_SCOPE_DISMISS_COOLDOWN_DAYS = 14;

/**
 * Set of candidate subject_ids that already have a PENDING goal_scope proposal
 * (a propose event with no chained rate). A subject in this set is "covered
 * tonight" — the cron skips it (gate 3). Keyed on subject_id (not scope ids), so
 * a subject with any live goal-scope proposal blocks near-duplicate goals.
 */
export async function loadPendingGoalScopeSubjects(db: Db): Promise<Set<string>> {
  const proposeRows = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:proposal'),
        eq(event.subject_kind, 'goal'),
        // RB-7 — exclude rubric-rejected (folded) propose events. They are
        // TERMINAL, not live-pending; counting one would permanently refuse
        // re-propose for the subject the rubric rejected. The marker is a
        // `rubric_verdict: { ok:false }` sibling of ai_proposal on the payload.
        sql`(${event.payload}->'rubric_verdict'->>'ok') IS DISTINCT FROM 'false'`,
      ),
    )
    .orderBy(desc(event.created_at));

  if (proposeRows.length === 0) return new Set();

  const proposeIds = proposeRows.map((r) => r.id);
  // FIX-1 / FIX-3 (BLOCKING): key the decision query ONLY on caused_by_event_id —
  // NO subject_kind filter. The goal accept/dismiss rate is subject_kind:'event',
  // and the retract `correct` event is ALSO subject_kind:'event'. Both a chained
  // `rate` (accept/dismiss) and a chained `correct` (retract) mean DECIDED, not
  // pending — so a retracted/stale propose drops out of the pending set instead of
  // locking the subject out of re-propose forever.
  const decisionRows = await db
    .select({ caused_by_event_id: event.caused_by_event_id })
    .from(event)
    .where(
      and(
        inArray(event.action, ['rate', 'correct']),
        inArray(event.caused_by_event_id, proposeIds),
      ),
    );
  const decidedProposeIds = new Set(
    decisionRows.map((r) => r.caused_by_event_id).filter((id): id is string => id !== null),
  );

  const out = new Set<string>();
  for (const row of proposeRows) {
    if (decidedProposeIds.has(row.id)) continue; // any chained rate/correct → decided, not pending
    const payload = row.payload as {
      ai_proposal?: { proposed_change?: { subject_id?: unknown } };
    };
    const subjectId = payload?.ai_proposal?.proposed_change?.subject_id;
    // ND-1 / FIX-4: cross-subject goals allow a null/undefined subject_id. Skip
    // nulls (do NOT coerce / throw) — the Set must survive a null-scoped pending
    // proposal. Only a non-empty string blocks a subject.
    if (typeof subjectId === 'string' && subjectId.length > 0) {
      out.add(subjectId);
    }
  }
  return out;
}

/**
 * YUK-187 — dismiss-churn 冷却集：最近 cooldownDays 内被 owner dismiss 的 goal_scope
 * 候选 subject_id 集合。此前 dismiss 只让提案离开 pending 集（decided），下一夜 cron
 * 即可重提同一 subject——owner 的「不要这个」判断没有任何记忆。
 *
 * dismiss 的真相形态（writeProposalRateEvent）：action='rate'、payload.rating='dismiss'、
 * caused_by_event_id=proposeId。冷却只看窗内 dismiss；窗过期 → subject 重新可提
 * （owner 可能改变主意，冷却不是永久拉黑）。accept/retract 不进冷却集。
 */
export async function loadDismissedGoalScopeSubjects(
  db: Db,
  cooldownDays: number = GOAL_SCOPE_DISMISS_COOLDOWN_DAYS,
  now: Date = new Date(),
): Promise<Set<string>> {
  const since = new Date(now.getTime() - cooldownDays * 86_400_000);
  const dismissRows = await db
    .select({ caused_by_event_id: event.caused_by_event_id })
    .from(event)
    .where(
      and(
        eq(event.action, 'rate'),
        sql`(${event.payload}->>'rating') = 'dismiss'`,
        gte(event.created_at, since),
      ),
    );
  const proposeIds = dismissRows
    .map((r) => r.caused_by_event_id)
    .filter((id): id is string => id !== null);
  if (proposeIds.length === 0) return new Set();

  const proposeRows = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(
      and(
        inArray(event.id, proposeIds),
        eq(event.action, 'experimental:proposal'),
        eq(event.subject_kind, 'goal'),
      ),
    );

  const out = new Set<string>();
  for (const row of proposeRows) {
    const payload = row.payload as {
      ai_proposal?: { proposed_change?: { subject_id?: unknown } };
    };
    const subjectId = payload?.ai_proposal?.proposed_change?.subject_id;
    // 与 loadPending 同款 ND-1 纪律：null/非字符串 subject_id 跳过（cross-subject goal）。
    if (typeof subjectId === 'string' && subjectId.length > 0) {
      out.add(subjectId);
    }
  }
  return out;
}
