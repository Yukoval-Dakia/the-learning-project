// Served-but-unanswered probes for active conjectures. The claim is deliberately
// absent: the owner already saw it, and the answer area shows the neutral question,
// not a "we think you're wrong" primer. No calibration number crosses the wire.

import { and, desc, eq } from 'drizzle-orm';
import { MAX_CONCURRENT_ACTIVE_PROBES } from '@/core/schema/conjecture';
import type { Db } from '@/db/client';
import {
  assessment_issuance,
  event,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { activeProbePredicate, probeIssuanceIdSql } from '@/kernel/read-models/probe-delivery';
import { validateIssuedProbeFromProposal } from './teaching-brief';

// Single-source the persisted probe contract from core, not another capability's server.
export const ACTIVE_PROBES_MAX = MAX_CONCURRENT_ACTIVE_PROBES;

export interface ActiveProbe {
  probe_question_id: string;
  prompt_md: string;
  knowledge_id: string | null;
}

export interface ActiveProbesResult {
  probes: ActiveProbe[];
}

/** Load the capped served-but-unanswered probes, newest first. */
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
      eq(assessment_issuance.issuance_id, probeIssuanceIdSql(question.id)),
    )
    .innerJoin(
      question_revision,
      eq(question_revision.revision_id, assessment_issuance.revision_id),
    )
    .where(
      and(
        // Same active set countActiveProbes caps on, filtered before the window; only
        // valid issued provenance may then be advertised as answerable.
        activeProbePredicate(),
        eq(question_group_lifecycle.scoring_admission_state, 'admitted'),
        eq(question_group_lifecycle.suspended, false),
        eq(question_group_lifecycle.withdrawn, false),
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
