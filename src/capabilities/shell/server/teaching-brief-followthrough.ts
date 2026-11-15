import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { isLearnerLocalDay, learnerLocalDay } from '@/core/learner-day';
import { BRIEF_SEEN_ACTION, PRIMARY_ACTION_STARTED_ACTION } from '@/core/schema/conjecture';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { getCorrectionStatuses } from '@/kernel/events';
import { allowedEventIds } from '@/kernel/events/derivation-policy';
import { loadSettledKnowledgeAnswerCounts } from '@/kernel/read-models/learner-activity';

// Two distinct learner days distinguish repeated exposure from a single visit.
const SEEN_WITHOUT_ACTION_DAYS = 2;
const INTERACTION_SCAN_LIMIT = 200;

function interactionTime(
  raw: unknown,
  localDay: unknown,
  createdAt: Date,
  resultAt: Date,
  now: Date,
): Date | null {
  if (typeof raw !== 'string' || typeof localDay !== 'string') return null;
  const at = new Date(raw);
  if (
    !Number.isFinite(at.getTime()) ||
    at.toISOString() !== raw ||
    at.getTime() !== createdAt.getTime() ||
    at < resultAt ||
    at > now ||
    !isLearnerLocalDay(localDay) ||
    learnerLocalDay(at) !== localDay
  ) {
    return null;
  }
  return at;
}

/** Presentation only: no acknowledgement or learner-state mutation. */
export async function loadOutcomeFollowthrough(
  db: Db | Tx,
  input: {
    briefId: string;
    resultId: string;
    resultAt: Date;
    knowledgeId: string;
    state: 'outcome_confirmed' | 'outcome_evidence_for' | 'outcome_retired';
  },
  now: Date,
): Promise<{ completed: boolean; deprioritized: boolean }> {
  const unchanged = { completed: false, deprioritized: false };
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(input.resultAt.getTime()) ||
    input.resultAt > now
  ) {
    return unchanged;
  }
  const rows = await db
    .select({
      id: event.id,
      action: event.action,
      payload: event.payload,
      createdAt: event.created_at,
    })
    .from(event)
    .where(
      and(
        eq(event.actor_kind, 'user'),
        eq(event.actor_ref, 'self'),
        eq(event.subject_kind, 'event'),
        eq(event.subject_id, input.briefId),
        eq(event.caused_by_event_id, input.briefId),
        inArray(event.action, [BRIEF_SEEN_ACTION, PRIMARY_ACTION_STARTED_ACTION]),
        gte(event.created_at, input.resultAt),
        lte(event.created_at, now),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(INTERACTION_SCAN_LIMIT + 1);
  // A partial ledger cannot establish either completion or absence of action.
  if (rows.length === 0 || rows.length > INTERACTION_SCAN_LIMIT) return unchanged;
  const ids = rows.map((row) => row.id);
  const allowed = await allowedEventIds(db, ids);
  const corrections = await getCorrectionStatuses(db, ids);
  const seenDays = new Set<string>();
  let startedAt: Date | null = null;
  for (const row of rows) {
    if (!allowed.has(row.id) || corrections.get(row.id)?.state !== 'active') continue;
    const payload = row.payload;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return unchanged;
    if (row.action === BRIEF_SEEN_ACTION && payload.brief_state === input.state) {
      const seenAt = interactionTime(
        payload.seen_at,
        payload.local_day,
        row.createdAt,
        input.resultAt,
        now,
      );
      if (!seenAt) return unchanged;
      seenDays.add(learnerLocalDay(seenAt));
    }
    if (
      row.action !== PRIMARY_ACTION_STARTED_ACTION ||
      input.state !== 'outcome_confirmed' ||
      payload.action_kind !== 'scoped_practice' ||
      payload.result_event_id !== input.resultId
    ) {
      continue;
    }
    const at = interactionTime(
      payload.started_at,
      payload.local_day,
      row.createdAt,
      input.resultAt,
      now,
    );
    if (!at) return unchanged;
    if (!startedAt || at < startedAt) startedAt = at;
  }
  if (!startedAt) {
    return { completed: false, deprioritized: seenDays.size >= SEEN_WITHOUT_ACTION_DAYS };
  }
  const answers = await loadSettledKnowledgeAnswerCounts(db, {
    knowledgeIds: [input.knowledgeId],
    // The shared window is inclusive at its lower bound. Start itself is not practice;
    // count learner answer creation, so regrading an earlier answer cannot complete it.
    since: new Date(startedAt.getTime() + 1),
    until: now,
  });
  const counts = answers.counts.get(input.knowledgeId);
  return {
    completed:
      answers.complete &&
      counts !== undefined &&
      counts.correct + counts.wrong + counts.partial > 0,
    deprioritized: false,
  };
}
