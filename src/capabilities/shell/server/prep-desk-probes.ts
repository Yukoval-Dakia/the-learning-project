// YUK-567 slice-2 — 备课台 active-probes read model (the "待你试做" queue).
//
// Lists the served-but-unanswered mind_probe questions for active conjectures:
// `source='mind_probe'` questions with NO `experimental:probe_result` event and no
// effective correction on their proposal. This is the LIST counterpart to
// `countActiveProbes` (probe-lifecycle.ts), surfaced for the 作答区 UI. Bounded by
// MAX_CONCURRENT_ACTIVE_PROBES (3) at serve time; the reader caps defensively at
// the same felt size.
//
// Anti-guilt (same contract as loadPrepDeskConjectures): NO calibration number
// crosses the wire — a probe carries only its prompt (the question the team is about
// to ask). The claim is deliberately NOT surfaced here: the owner already saw it when
// they accepted the conjecture; the 作答区 shows the neutral probe question, not a
// "we think you're wrong about X" primer.

import { and, desc, eq, sql } from 'drizzle-orm';
import {
  MAX_CONCURRENT_ACTIVE_PROBES,
  PROBE_QUESTION_SOURCE,
  PROBE_RESULT_ACTION,
} from '@/core/schema/conjecture';
import type { Db } from '@/db/client';
import {
  assessment_issuance,
  event,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { validateIssuedProbeFromProposal } from './teaching-brief';

// Single-source the persisted probe contract from core without reaching into the
// agency capability's server implementation.
export const ACTIVE_PROBES_MAX = MAX_CONCURRENT_ACTIVE_PROBES;

export interface ActiveProbe {
  /** The mind_probe question id — target of POST /api/conjecture/probe/[id]/answer. */
  probe_question_id: string;
  /** The probe prompt — the question the team is about to ask. */
  prompt_md: string;
  /** The KC the probe targets (first knowledge id), or null. */
  knowledge_id: string | null;
}

export interface ActiveProbesResult {
  probes: ActiveProbe[];
}

/**
 * Load the ≤3 served-but-unanswered probes for active conjectures, newest first.
 */
export async function loadActiveProbes(db: Db): Promise<ActiveProbesResult> {
  const rows = await db
    .select({
      probe: question,
      proposal: event,
      issuance: assessment_issuance,
      revision: question_revision,
    })
    .from(question)
    .leftJoin(event, eq(event.id, question.source_ref))
    .innerJoin(question_group_lifecycle, eq(question_group_lifecycle.group_id, question.id))
    .innerJoin(
      assessment_issuance,
      eq(assessment_issuance.issuance_id, sql<string>`'iss_probe_' || ${question.id}`),
    )
    .innerJoin(
      question_revision,
      eq(question_revision.revision_id, assessment_issuance.revision_id),
    )
    .where(
      and(
        eq(question.source, PROBE_QUESTION_SOURCE),
        eq(question_group_lifecycle.scoring_admission_state, 'admitted'),
        eq(question_group_lifecycle.suspended, false),
        eq(question_group_lifecycle.withdrawn, false),
        sql`NOT EXISTS (
          SELECT 1 FROM ${event}
          WHERE ${event.subject_kind} = 'question'
            AND ${event.subject_id} = ${question.id}
            AND ${event.action} = ${PROBE_RESULT_ACTION}
        )`,
        // Mirror getCorrectionStatuses' latest-write-wins fold in SQL so stale,
        // unanswered probes are removed before the three-row window is applied.
        // Capacity accounting remains in countActiveProbes; only valid issued
        // provenance may be advertised as answerable here.
        sql`(
          COALESCE(${question.metadata}->>'conjecture_proposal_id', '') = ''
          OR COALESCE((
            SELECT correction.payload->>'correction_kind'
            FROM ${event} AS correction
            WHERE correction.action = 'correct'
              AND correction.subject_kind = 'event'
              AND correction.subject_id =
                  ${question.metadata}->>'conjecture_proposal_id'
              AND (
                (correction.payload->>'correction_kind' = 'supersede'
                  AND COALESCE(correction.payload->>'replacement_event_id', '') <> '')
                OR (correction.payload->>'correction_kind' IN
                    ('retract', 'mark_wrong', 'restore')
                  AND NOT correction.payload ? 'replacement_event_id')
              )
            ORDER BY correction.created_at DESC, correction.id DESC
            LIMIT 1
          ), '') NOT IN ('retract', 'mark_wrong', 'supersede')
        )`,
      ),
    )
    .orderBy(desc(question.created_at), desc(question.id))
    .limit(ACTIVE_PROBES_MAX);
  const probes: ActiveProbe[] = [];
  for (const row of rows) {
    const issued = validateIssuedProbeFromProposal({
      probe: row.probe,
      issuance: row.issuance,
      revision: row.revision,
      proposalRow: row.proposal,
    });
    if ('reason' in issued) continue;
    probes.push({
      probe_question_id: row.probe.id,
      prompt_md: issued.value.promptMd,
      knowledge_id: issued.value.knowledgeId,
    });
  }
  return { probes };
}
