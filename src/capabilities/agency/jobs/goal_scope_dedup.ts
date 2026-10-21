// goal_scope pending-proposal dedup scan.
//
// The decision query keys ONLY on caused_by_event_id, with NO subject_kind filter: the
// accept/dismiss rate event and the retract `correct` event are both subject_kind:'event',
// so a subject_kind='goal' filter would match zero rows and a decided proposal would read
// as pending forever. Pending means NEITHER a chained `rate` NOR a chained `correct`
// (retract writes `correct`), otherwise a retracted proposal locks the subject out.

import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { event } from '@/db/schema';

/** dismiss 冷却窗：被 dismiss 的 goal_scope 候选在该窗口内不再重提。 */
export const GOAL_SCOPE_DISMISS_COOLDOWN_DAYS = 14;

/**
 * Candidate subject_ids that already have a PENDING goal_scope proposal. Keyed on
 * subject_id (not scope ids), so any live goal-scope proposal blocks near-duplicate goals.
 */
export async function loadPendingGoalScopeSubjects(db: Db): Promise<Set<string>> {
  const proposeRows = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:proposal'),
        eq(event.subject_kind, 'goal'),
        // Exclude rubric-rejected (folded) propose events: they are TERMINAL, not
        // live-pending; counting one would permanently refuse re-propose.
        sql`(${event.payload}->'rubric_verdict'->>'ok') IS DISTINCT FROM 'false'`,
      ),
    )
    .orderBy(desc(event.created_at));

  if (proposeRows.length === 0) return new Set();

  const proposeIds = proposeRows.map((r) => r.id);
  // No subject_kind filter — see the header constraint.
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
    if (decidedProposeIds.has(row.id)) continue; // chained rate/correct → decided, not pending
    const payload = row.payload as {
      ai_proposal?: { proposed_change?: { subject_id?: unknown } };
    };
    const subjectId = payload?.ai_proposal?.proposed_change?.subject_id;
    // Cross-subject goals may have a null/undefined subject_id. Skip them (do NOT
    // coerce / throw); only a non-empty string blocks a subject.
    if (typeof subjectId === 'string' && subjectId.length > 0) {
      out.add(subjectId);
    }
  }
  return out;
}

/**
 * goal_scope 候选 subject_id 集合：最近 cooldownDays 内被 owner dismiss。窗过期即重新
 * 可提（冷却不是永久拉黑）；accept/retract 不进冷却集。
 *
 * dismiss 形态：action='rate'、payload.rating='dismiss'、caused_by_event_id=proposeId。
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
    // 与 loadPending 同款纪律：null/非字符串 subject_id 跳过（cross-subject goal）。
    if (typeof subjectId === 'string' && subjectId.length > 0) {
      out.add(subjectId);
    }
  }
  return out;
}
