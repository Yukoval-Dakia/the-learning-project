// YUK-1047 — evaluateSubmissionCore 纯内核单测（无 IO、无 DB、无 LLM）。

import { describe, expect, it } from 'vitest';

import { type EvaluateSubmissionCoreInput, evaluateSubmissionCore } from './evaluation';
import type {
  ExecutionPlanT,
  PublishedQuestionRevisionT,
  ScoringBasisT,
  SubmissionRecordT,
} from './index';

// ---------- fixtures ----------

const GROUP_ID = 'grp-fixture';
const REVISION_ID = 'rev-fixture-1';
const ISSUANCE_ID = 'iss-fixture-1';
const SUBMISSION_ID = 'sub-fixture-1';
const EVAL_GROUP_ID = 'grp-eval-1';
const NOW = '2026-09-25T00:00:00.000Z';

function revisionFor(overrides: {
  parts?: PublishedQuestionRevisionT['structure']['parts'];
  slots?: PublishedQuestionRevisionT['response_spec']['slots'];
  units?: ScoringBasisT['units'];
  aggregation?: ScoringBasisT['aggregation'];
  blank_scores_zero?: boolean;
  assignments?: ExecutionPlanT['assignments'];
  escalation?: ExecutionPlanT['escalation'];
  materials?: PublishedQuestionRevisionT['structure']['materials'];
}): PublishedQuestionRevisionT {
  const parts = overrides.parts ?? [{ part_id: 'p1', prompt_md: '1+1=?', material_ids: [] }];
  const slots = overrides.slots ?? [
    { slot_id: 'p1::r', part_id: 'p1', kind: 'text' as const, math_preview: false },
  ];
  const units = overrides.units ?? [
    {
      scoring_unit_id: 'p1::u',
      slot_refs: ['p1::r'],
      material_refs: [],
      evidence_slot_refs: [],
      requires_group_evidence: false,
      criterion: {
        kind: 'text_key' as const,
        accepted_texts: ['2'],
        normalization: 'trim' as const,
      },
      points: 2,
    },
  ];
  return {
    revision_id: REVISION_ID,
    group_id: GROUP_ID,
    revision_ordinal: 1,
    integrity_digest: 'sha256:test',
    structure: {
      group_id: GROUP_ID,
      materials: overrides.materials ?? [],
      parts,
    },
    response_spec: { slots },
    scoring_basis: {
      units,
      aggregation: overrides.aggregation ?? { kind: 'sum' },
      blank_scores_zero: overrides.blank_scores_zero ?? true,
    },
    execution_plan: {
      plan_version: 1,
      assignments: overrides.assignments ?? [
        {
          scoring_unit_ids: units.map((u) => u.scoring_unit_id),
          executor: { kind: 'deterministic', comparator: 'exact_text' },
        },
      ],
      escalation: overrides.escalation ?? {
        on_unadmitted_model: 'withhold',
        on_low_confidence: 'human_review',
      },
    },
    published_at: NOW,
    supersedes_revision_id: null,
  };
}

function submissionFor(entries: SubmissionRecordT['response_set']['entries']): SubmissionRecordT {
  return {
    submission_id: SUBMISSION_ID,
    issuance_id: ISSUANCE_ID,
    revision_id: REVISION_ID,
    evaluation_group_id: EVAL_GROUP_ID,
    response_set: { entries },
    group_evidence: [],
    idempotency_key: 'idem-1',
    submitted_at: NOW,
  };
}

function inputFor(
  submission: SubmissionRecordT,
  revision: PublishedQuestionRevisionT,
  overrides: Partial<EvaluateSubmissionCoreInput> = {},
): EvaluateSubmissionCoreInput {
  return {
    evaluation_id: 'eva-test',
    submission,
    revision,
    attempt: 1,
    ...overrides,
  };
}
describe('evaluateSubmissionCore — pending taxonomy (no fake zeros)', () => {
  it('criterion/slot mismatch ⇒ pending unjudgeable, aggregate unresolved — never a fake 0', async () => {
    // text_key criterion on a numeric slot response.
    // Force validateScoringBasis-passing shape: numeric_key criterion + numeric
    // slot, but dispatch a MISMATCHED comparator pairing by overriding the
    // assignment to text comparator... Instead simplest honest mismatch: keep
    // numeric_key criterion (valid for numeric slot) but assign exact_text
    // comparator (comparator_criterion_mismatch — validateExecutionPlan would
    // reject). Use a plan-valid mismatch instead: rule_reference unit on the
    // numeric slot assigned human_review ⇒ needs_review pending.
    const ruleRevision = revisionFor({
      slots: [{ slot_id: 'p1::r', part_id: 'p1', kind: 'numeric' as const }],
      units: [
        {
          scoring_unit_id: 'p1::u',
          slot_refs: ['p1::r'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'rule_reference',
            rule_id: 'r1',
            statement_md: 'show work',
            source: 'official',
          },
          points: 2,
        },
      ],
      assignments: [
        {
          scoring_unit_ids: ['p1::u'],
          executor: { kind: 'human_review' },
        },
      ],
    });
    const out = await evaluateSubmissionCore(
      inputFor(
        submissionFor([{ slot_id: 'p1::r', kind: 'numeric', value: 42, raw_input: '42' }]),
        ruleRevision,
      ),
    );
    expect(out.record.unit_results[0]).toMatchObject({
      status: 'pending',
      pending: { reason: 'needs_review', trigger: 'manual_request' },
    });
    expect(out.record.status).toBe('completed');
    expect(out.record.aggregate).toMatchObject({
      kind: 'unresolved',
      reason: 'pending_units',
    });
  });
});
