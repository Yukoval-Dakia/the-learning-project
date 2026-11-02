// Delivery identity and the served-but-unanswered predicate for mind-probe questions.
// Agency serves/answers probes and shell projects them; both read these facts here.

import { type SQLWrapper, and, eq, sql } from 'drizzle-orm';
import { PROBE_QUESTION_SOURCE, PROBE_RESULT_ACTION } from '@/core/schema/conjecture';
import { event, question } from '@/db/schema';
import { eventCorrectionActiveSql } from '@/kernel/events';

/** The one native issuance a probe question is delivered under. */
export function probeIssuanceId(probeQuestionId: string): string {
  return `iss_probe_${probeQuestionId}`;
}

/** SQL form of probeIssuanceId for joining issuance rows to probe questions. */
export function probeIssuanceIdSql(probeQuestionId: SQLWrapper) {
  return sql<string>`'iss_probe_' || ${probeQuestionId}`;
}

/**
 * A probe question that holds an active slot: no probe result yet and its conjecture
 * proposal is not corrected away. Missing provenance stays active so corrupt rows
 * cannot silently free a slot. serveProbeOnce counts this under lockProbeServe.
 */
export function activeProbePredicate() {
  return and(
    eq(question.source, PROBE_QUESTION_SOURCE),
    sql`NOT EXISTS (
          SELECT 1 FROM ${event}
          WHERE ${event.subject_kind} = 'question'
            AND ${event.subject_id} = ${question.id}
            AND ${event.action} = ${PROBE_RESULT_ACTION}
        )`,
    sql`(
          COALESCE(${question.metadata}->>'conjecture_proposal_id', '') = ''
          OR ${eventCorrectionActiveSql(sql`${question.metadata}->>'conjecture_proposal_id'`)}
        )`,
  );
}
