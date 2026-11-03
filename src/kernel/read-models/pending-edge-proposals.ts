// SQL form of the inbox 'pending' status for knowledge-edge propose events, in the
// same order as deriveProposalStatus: the correction fold leaves the event active,
// no rubric/topology fold reject, and the latest chained rate is not terminal.
// Counts and rails read this; producer dedup still uses the full inbox rows
// (checkProposalCooldownGate) because it also needs dismissed rows for cooldown.
//
// Known gap: rows whose payload fails the inbox's Zod parse are dropped from the
// inbox but kept here when the endpoint fields are strings.

import { and, eq, not, sql } from 'drizzle-orm';
import { event } from '@/db/schema';
import { eventCorrectionActiveSql } from '@/kernel/events';
import { proposalLatestRateTerminalSql } from '@/kernel/proposals/inbox';

/** WHERE clause over the unaliased `event` table, so caps see only pending rows. */
export function pendingEdgeProposeEventPredicate() {
  return and(
    eq(event.action, 'propose'),
    eq(event.subject_kind, 'knowledge_edge'),
    eventCorrectionActiveSql(event.id),
    // A topology reject carries no rubric marker, so both predicates are required.
    sql`(${event.payload}->'rubric_verdict'->>'ok') IS DISTINCT FROM 'false'`,
    sql`(${event.payload}->'topology_verdict'->>'status') IS DISTINCT FROM 'reject'`,
    not(proposalLatestRateTerminalSql(event.id)),
  );
}
