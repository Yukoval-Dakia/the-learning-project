import type { ConjectureProbeSpecV2T } from '@/core/schema/business';
import { ConjectureProposalChange, type ConjectureProposalChangeT } from '@/core/schema/proposal';

/** Freeze the complete original package and its audit, using the real proposal schema. */
export function withProbeSpecs(
  change: ConjectureProposalChangeT,
  primary: ConjectureProbeSpecV2T,
  followup: ConjectureProbeSpecV2T,
): ConjectureProposalChangeT {
  const diagnostic = {
    schema_version: 1 as const,
    target_error_rule_md: 'Adds the outer and inner derivatives instead of multiplying them.',
    trigger_conditions_md: 'Differentiating a composite function with a nonconstant inner term.',
    scope_boundary_md: 'Does not generalize to other differentiation rules or arithmetic slips.',
    expected_wrong_answer_signature_md: 'Outer derivative plus inner derivative.',
  };
  return ConjectureProposalChange.parse({
    ...change,
    probe_md: primary.prompt_md,
    probe_reference_md: primary.reference_md,
    followup_probe_md: followup.prompt_md,
    followup_probe_reference_md: followup.reference_md,
    diagnostic_spec: diagnostic,
    probe_spec: primary,
    followup_probe_spec: followup,
    probe_quality: {
      schema_version: 3,
      passed: true,
      attempts: [
        {
          attempt: 1,
          outcome: 'passed',
          failure_codes: [],
          explanation_md: 'Offline fixture package has distinct gold and target signatures.',
          author_task_run_id: 'offline-author',
          reviewer_task_run_id: 'offline-reviewer',
        },
      ],
      final_review: { verdict: 'pass', failure_codes: [], explanation_md: 'Offline fixture.' },
      reviewed_hypothesis: {
        kind: 'proposal',
        claim_md: change.claim_md,
        knowledge_id: change.knowledge_id,
        cause_category: change.cause_category,
        recurrence_count: change.recurrence_count,
        diagnostic_spec: diagnostic,
        evidence_event_ids: ['offline-evidence'],
      },
      reviewed_package: { primary, followup, predicted_p: change.predicted_p },
    },
  });
}
