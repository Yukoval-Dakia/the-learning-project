import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { stableStringify } from '@/core/migration/canonical';
import { PublishedQuestionRevision, projectPracticeIssuance } from '@/core/schema/assessment';
import type { ConjectureProbeSpecT } from '@/core/schema/business';
import { PROBE_QUESTION_SOURCE } from '@/core/schema/conjecture';
import type { Db, Tx } from '@/db/client';
import {
  type assessment_issuance,
  assessment_submission,
  evaluation,
  type event,
  type question,
  type question_revision,
} from '@/db/schema';
import { issuanceRowToContract, revisionRowToContract } from '@/kernel/records/assessment-issuance';

export interface CompletedProbeProposal {
  id: string;
  knowledgeId: string;
  probeMd: string;
  probeReferenceMd: string;
  probeSpec: ConjectureProbeSpecT | null;
  followupProbeMd: string | null;
  followupProbeReferenceMd: string | null;
  followupProbeSpec: ConjectureProbeSpecT | null;
}

type ResultRow = Pick<typeof event.$inferSelect, 'id' | 'subject_id' | 'caused_by_event_id'> & {
  payload: unknown;
};
type ProbeIdentity = Pick<
  typeof question.$inferSelect,
  'id' | 'source' | 'source_ref' | 'metadata' | 'created_at'
>;
type AssessmentAnchor = {
  evaluation: typeof evaluation.$inferSelect;
  submission: typeof assessment_submission.$inferSelect;
};

const AssessmentRefs = z.object({
  issuance_id: z.string().min(1),
  submission_id: z.string().min(1),
  evaluation_id: z.string().min(1),
});
const ResultProvenance = z.object({
  conjecture_event_id: z.string().min(1),
  assessment: AssessmentRefs.optional(),
});
const ProbeMetadata = z.object({
  conjecture_proposal_id: z.string().min(1),
  probe_sequence: z.union([z.literal(1), z.literal(2)]).default(1),
});
const AutomaticProvenance = z.object({
  source: z.literal('automatic'),
  assisted: z.literal(false),
});

/** Immutable native records referenced by results, loaded once per evidence batch. */
export async function loadCompletedProbeAssessmentAnchors(
  db: Db | Tx,
  results: readonly ResultRow[],
): Promise<Map<string, AssessmentAnchor>> {
  const ids = [
    ...new Set(
      results.flatMap((result) => {
        const parsed = ResultProvenance.safeParse(result.payload);
        return parsed.success && parsed.data.assessment
          ? [parsed.data.assessment.evaluation_id]
          : [];
      }),
    ),
  ];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ evaluation, submission: assessment_submission })
    .from(evaluation)
    .innerJoin(
      assessment_submission,
      eq(assessment_submission.submission_id, evaluation.submission_id),
    )
    .where(inArray(evaluation.evaluation_id, ids));
  return new Map(rows.map((row) => [row.evaluation.evaluation_id, row]));
}

export type CompletedProbeProvenanceResult =
  | {
      value: {
        probeQuestionId: string;
        conjectureEventId: string;
        knowledgeId: string;
        sequence: 1 | 2;
        promptMd: string;
      };
    }
  | { reason: string };

/**
 * Issued probes use the original proposal, issuance and revision.
 * Question source/refs/sequence are not editor fields and remain identity guards.
 * Editable KC, draft status, kind, choices and content cannot reinterpret a result.
 * Callers retain correction/status folds and the historical unissued row contract.
 */
export function validateIssuedProbeProvenance({
  probe,
  proposal,
  issuance,
  revision,
  now,
}: {
  probe: ProbeIdentity;
  proposal: CompletedProbeProposal;
  issuance: typeof assessment_issuance.$inferSelect;
  revision: typeof question_revision.$inferSelect | null;
  now?: Date;
}): CompletedProbeProvenanceResult {
  if (probe.source !== PROBE_QUESTION_SOURCE) return { reason: 'probe_source_mismatch' };
  if (now && probe.created_at.getTime() > now.getTime())
    return { reason: 'probe_created_in_future' };
  if (probe.source_ref !== proposal.id) return { reason: 'probe_source_ref_mismatch' };
  const metadata = ProbeMetadata.safeParse(probe.metadata);
  if (!metadata.success) return { reason: 'probe_metadata_invalid' };
  if (metadata.data.conjecture_proposal_id !== proposal.id) {
    return { reason: 'probe_metadata_ref_mismatch' };
  }
  const sequence = metadata.data.probe_sequence;
  const expectedPrompt = sequence === 2 ? proposal.followupProbeMd : proposal.probeMd;
  const expectedReference =
    sequence === 2 ? proposal.followupProbeReferenceMd : proposal.probeReferenceMd;
  const expectedSpec = sequence === 2 ? proposal.followupProbeSpec : proposal.probeSpec;
  if (expectedPrompt === null || expectedReference === null)
    return { reason: 'probe_followup_missing' };
  if (
    !revision ||
    revision.group_id !== probe.id ||
    issuance.issuance_id !== `iss_probe_${probe.id}` ||
    issuance.container_occurrence_ref !== `probe:${probe.id}`
  ) {
    return { reason: 'probe_issuance_unprojectable' };
  }
  try {
    const published = PublishedQuestionRevision.parse(revisionRowToContract(revision));
    const frozen = projectPracticeIssuance(published, issuanceRowToContract(issuance));
    const slot = frozen.response_spec.slots[0];
    const unit = published.scoring_basis.units[0];
    if (
      frozen.response_spec.slots.length !== 1 ||
      slot.kind !== 'open_response' ||
      published.scoring_basis.units.length !== 1 ||
      !unit.slot_refs.includes(slot.slot_id) ||
      unit.criterion.kind !== 'rule_reference'
    ) {
      return { reason: 'unsupported_probe_contract' };
    }
    const promptMd = frozen.faces.map((part) => part.prompt_md).join('\n\n');
    if (promptMd !== expectedPrompt) return { reason: 'probe_prompt_mismatch' };
    const criterion = unit.criterion;
    // Proposal loaders parse the complete original spec; the published schema
    // parses the frozen counterpart. Compare every typed field, including nested
    // signatures, without depending on editable question metadata or key order.
    // Either-side presence prevents a native spec from becoming legacy scoring.
    if (expectedSpec !== null || criterion.probe_spec !== undefined) {
      if (
        expectedSpec === null ||
        criterion.probe_spec === undefined ||
        stableStringify(criterion.probe_spec) !== stableStringify(expectedSpec)
      ) {
        return { reason: 'probe_spec_mismatch' };
      }
    } else if (
      criterion.statement_md !== expectedReference &&
      criterion.statement_md !== `${expectedReference}\n\n（判分意图：multimodal_direct）`
    ) {
      return { reason: 'probe_reference_mismatch' };
    }
    return {
      value: {
        probeQuestionId: probe.id,
        conjectureEventId: proposal.id,
        knowledgeId: proposal.knowledgeId,
        sequence,
        promptMd,
      },
    };
  } catch {
    return { reason: 'probe_issuance_unprojectable' };
  }
}

/** Completed results also bind their native submission and automatic evaluation. */
export function validateCompletedProbeProvenance({
  result,
  assessmentAnchors,
  ...issued
}: Parameters<typeof validateIssuedProbeProvenance>[0] & {
  result: ResultRow;
  assessmentAnchors: ReadonlyMap<string, AssessmentAnchor>;
}): CompletedProbeProvenanceResult {
  const provenance = ResultProvenance.safeParse(result.payload);
  if (
    !provenance.success ||
    provenance.data.conjecture_event_id !== issued.proposal.id ||
    result.caused_by_event_id !== issued.proposal.id ||
    result.subject_id !== issued.probe.id
  ) {
    return { reason: 'result_provenance_mismatch' };
  }
  const validated = validateIssuedProbeProvenance(issued);
  if ('reason' in validated) return validated;
  const refs = provenance.data.assessment;
  if (refs) {
    const anchor = assessmentAnchors.get(refs.evaluation_id);
    if (
      refs.issuance_id !== issued.issuance.issuance_id ||
      !anchor ||
      anchor.submission.submission_id !== refs.submission_id ||
      anchor.submission.issuance_id !== issued.issuance.issuance_id ||
      anchor.submission.revision_id !== issued.revision?.revision_id ||
      anchor.evaluation.submission_id !== refs.submission_id ||
      anchor.evaluation.evaluation_group_id !== anchor.submission.evaluation_group_id ||
      anchor.evaluation.status !== 'completed' ||
      !AutomaticProvenance.safeParse(anchor.evaluation.provenance).success
    ) {
      return { reason: 'result_assessment_mismatch' };
    }
  }
  return validated;
}
