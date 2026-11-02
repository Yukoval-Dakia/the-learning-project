// Pending knowledge-edge propose events by event scan: not fold-rejected (rubric or
// topology) and no chained rate. A cheap SQL form for counts and rails; unlike the
// inbox status it ignores corrections and rating values, so producer dedup uses the
// inbox gate (checkProposalCooldownGate) instead.

import { and, eq, sql } from 'drizzle-orm';
import { event } from '@/db/schema';

/** WHERE clause over the unaliased `event` table; the rate check is in SQL so caps see only pending rows. */
export function pendingEdgeProposeEventPredicate() {
  return and(
    eq(event.action, 'propose'),
    eq(event.subject_kind, 'knowledge_edge'),
    // A topology reject carries no rubric marker, so both predicates are required.
    sql`(${event.payload}->'rubric_verdict'->>'ok') IS DISTINCT FROM 'false'`,
    sql`(${event.payload}->'topology_verdict'->>'status') IS DISTINCT FROM 'reject'`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${event} AS rate_event
      WHERE rate_event.action = 'rate'
        AND rate_event.subject_kind = 'knowledge_edge'
        AND rate_event.caused_by_event_id = ${event.id}
    )`,
  );
}
