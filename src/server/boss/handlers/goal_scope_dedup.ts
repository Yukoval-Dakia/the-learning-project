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
// The load-bearing divergence (FIX-1, BLOCKING): the chained-rate query keys
// ONLY on (action='rate', caused_by_event_id IN proposeIds) — NO subject_kind
// filter. The goal accept path writes its rate event as subject_kind:'event'
// (accept.ts:121), and dismiss/generic rate is ALSO subject_kind:'event'
// (writeGenericRateEvent, actions.ts). A subject_kind='goal' filter would match
// ZERO rows → an already-accepted-or-dismissed goal_scope propose mis-reads as
// still-pending → that subject is permanently locked out of re-propose.
// caused_by_event_id uniquely links the rate back to its propose (accept.ts:129),
// so it alone is the correct, sufficient join key.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { event } from '@/db/schema';

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
  // FIX-1 (BLOCKING): key the rate query ONLY on caused_by_event_id — NO
  // subject_kind filter. The goal accept/dismiss rate is subject_kind:'event'.
  const rateRows = await db
    .select({ caused_by_event_id: event.caused_by_event_id })
    .from(event)
    .where(and(eq(event.action, 'rate'), inArray(event.caused_by_event_id, proposeIds)));
  const ratedProposeIds = new Set(
    rateRows.map((r) => r.caused_by_event_id).filter((id): id is string => id !== null),
  );

  const out = new Set<string>();
  for (const row of proposeRows) {
    if (ratedProposeIds.has(row.id)) continue; // any chained rate → decided, not pending
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
