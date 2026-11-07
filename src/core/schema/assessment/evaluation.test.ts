// YUK-1047 — evaluateSubmissionCore 纯内核单测（无 IO、无 DB、无 LLM）。

import { describe, expect, it } from 'vitest';

import { type EvaluateSubmissionCoreInput, evaluateSubmissionCore } from './evaluation';
import type {
  ExecutionPlanT,
  PublishedQuestionRevisionT,
  ScoringBasisT,
  ScoringRuleT,
  ScoringUnitCriterionT,
  SubmissionRecordT,
} from './index';
import { type ResponseSlotT, ResponseSpec } from './response';
import {
  BlankNormalization,
  ScoringUnit,
  validateScoringBasis,
  wrongResponseFullMarksIssues,
} from './scoring';

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

// @invariant grading: frozen revisions retain their scores while new versions reject compatibility collisions without losing width folding or explicit aliases
// @fails-if text production grading or numeric parsing folds semantic symbols in new revisions, changes old replay scores, or rejects declared aliases and width variants
it('preserves frozen grading semantics and rejects compatibility collisions in new revisions', async () => {
  const rows: [
    'text' | 'blank' | 'numeric' | 'legacy-numeric',
    string,
    string[],
    string,
    0 | 1 | 'unparseable_response' | 'needs_review',
    string?,
  ][] = [
    ['text', 'answer_head', ['x²'], 'x2', 1],
    ['blank', 'blank-norm@1', ['x²'], 'x2', 1],
    ['numeric', '', [], '5²', 1],
    ['legacy-numeric', '', [], '5²', 1],
    ['text', 'answer_head@2', ['x²'], 'x2', 0],
    ['blank', 'blank-norm@2', ['x²'], 'x2', 0],
    ['text', 'answer_head@2', ['2tanα/(1-tan²α)'], '2tanα/(1-tan2α)', 0],
    ['blank', 'blank-norm@2', ['2tanα/(1-tan²α)'], '2tanα/(1-tan2α)', 0],
    ['numeric', 'numeric-norm@2', [], '5²', 'unparseable_response'],
    ['numeric', 'numeric-norm@2', [], '52', 1],
    ['numeric', 'numeric-norm@2', [], '５２', 1],
    ['legacy-numeric', 'numeric-norm@2', [], '5²', 'unparseable_response'],
    ['legacy-numeric', 'numeric-norm@2', [], '52', 1],
    ['legacy-numeric', 'numeric-norm@2', [], '５２', 1],
    ['text', 'answer_head@2', ['A(52)'], 'Ａ（５２）', 1],
    ['blank', 'blank-norm@2', ['A(52)'], 'Ａ（５２）', 1],
    ['text', 'answer_head@2', ['x²', 'x^2'], 'x²', 1],
    ['text', 'answer_head@2', ['x²', 'x^2'], 'x^2', 1],
    ['blank', 'blank-norm@2', ['x²', 'x^2'], 'x²', 1],
    ['blank', 'blank-norm@2', ['x²', 'x^2'], 'x^2', 1],
    ['blank', 'blank-norm@1', ['52'], '先展开 5²，所以 5²', 1],
    ['blank', 'blank-norm@2', ['52'], '先展开 5²，所以 5²', 'needs_review'],
    ['blank', 'blank-norm@2', ['2tanα/(1-tan²α)'], '所以 2tanα/(1-tan²α)', 1],
    ['numeric', 'numeric-norm@2', [], '5² m', 'unparseable_response', 'm'],
    ['numeric', 'numeric-norm@2', [], '10 m²', 1, 'm^2'],
    ['numeric', 'numeric-norm@2', [], '10 cm³', 1, 'cm3'],
    ['legacy-numeric', 'numeric-norm@2', [], '5² m', 'unparseable_response', 'm'],
    ['legacy-numeric', 'numeric-norm@2', [], '10 m²', 1, 'm^2'],
    ['legacy-numeric', 'numeric-norm@2', [], '10 cm³', 1, 'cm3'],
  ];
  for (const [kind, version, accepted, given, expected, expectedUnit] of rows) {
    const numeric = {
      expected: expectedUnit == null ? 52 : 10,
      ...(expectedUnit != null ? { expected_unit: expectedUnit } : {}),
      tolerance: { kind: 'absolute', value: 0 },
      ...(version === 'numeric-norm@2' ? { normalization_version: version } : {}),
    };
    const criterion =
      kind === 'text'
        ? { kind: 'text_key', accepted_texts: accepted, normalization: version }
        : kind === 'legacy-numeric'
          ? { kind: 'numeric_key', ...numeric }
          : {
              kind: 'blank_key',
              key:
                kind === 'numeric'
                  ? { kind: 'numeric', ...numeric }
                  : {
                      kind: 'text',
                      accepted,
                      normalization: BlankNormalization.parse({ version, nfkc: true }),
                    },
            };
    const slotKind = kind === 'text' ? 'text' : kind === 'legacy-numeric' ? 'numeric' : 'blank';
    const unit = ScoringUnit.parse({
      ...revisionFor({}).scoring_basis.units[0],
      criterion,
      points: 1,
      rule:
        slotKind === 'blank'
          ? {
              version: 1,
              cases: [{ when: { correct: { eq: 1 } }, award: { points: 1 } }],
              otherwise: { points: 0 },
            }
          : undefined,
    });
    const revision = revisionFor({
      slots: ResponseSpec.parse({ slots: [{ slot_id: 'p1::r', part_id: 'p1', kind: slotKind }] })
        .slots,
      units: [unit],
      assignments: [
        {
          scoring_unit_ids: ['p1::u'],
          executor: {
            kind: 'deterministic',
            comparator:
              kind === 'text'
                ? 'exact_text'
                : kind === 'legacy-numeric'
                  ? expectedUnit == null
                    ? 'numeric_tolerance'
                    : 'numeric_unit_conversion'
                  : 'blank_exact',
          },
        },
      ],
    });
    const entry: SubmissionRecordT['response_set']['entries'][number] =
      kind === 'text'
        ? { slot_id: 'p1::r', kind: 'text', text_md: given }
        : kind === 'legacy-numeric'
          ? { slot_id: 'p1::r', kind: 'numeric', value: 52, raw_input: given }
          : { slot_id: 'p1::r', kind: 'blank', state: 'answered', text: given };
    const result = await evaluateSubmissionCore(inputFor(submissionFor([entry]), revision));
    const scored = result.record.unit_results[0];
    expect(
      scored?.status === 'scored' ? scored.points_awarded : scored?.pending.reason,
      JSON.stringify({ kind, version, accepted, given, scored }),
    ).toBe(expected);
  }
});

// @invariant grading: entry barriers reject rules awarding full marks to a completely wrong response, while judging of already-published degenerate rules scores exactly as frozen
// @fails-if a wrong-answer-full-marks rule slips through the entry check, a legitimate zero/partial/unknown wrong-answer rule is flagged, or evaluateSubmissionCore changes its verdict on a published degenerate rule
it('entry check rejects wrong-answer-full-marks rules; the shared barrier and judging of frozen rules are unchanged', async () => {
  const selectSlot = ResponseSpec.parse({
    slots: [
      {
        slot_id: 'p1::r',
        part_id: 'p1',
        kind: 'select',
        items: [
          { item_id: 'a', label_md: 'A' },
          { item_id: 'b', label_md: 'B' },
          { item_id: 'c', label_md: 'C' },
        ],
      },
    ],
  }).slots[0];
  const blankSlot = ResponseSpec.parse({
    slots: [{ slot_id: 'p1::r', part_id: 'p1', kind: 'blank' }],
  }).slots[0];
  const blankCriterion: ScoringUnitCriterionT = {
    kind: 'blank_key',
    key: {
      kind: 'text',
      accepted: ['yes'],
      normalization: BlankNormalization.parse({ version: 'blank-norm@1' }),
    },
  };
  const selectCriterion = (key: string[]): ScoringUnitCriterionT => ({
    kind: 'select_key',
    accepted_item_ids: key,
  });
  const rows: {
    name: string;
    slot: ResponseSlotT | undefined;
    criterion: ScoringUnitCriterionT;
    rule: ScoringRuleT;
    points: number;
    comparator: 'set_compare' | 'blank_exact';
    entry: SubmissionRecordT['response_set']['entries'][number];
    entryIssues: string[];
    judged: number | null;
  }[] = [
    {
      name: 'degenerate blank rule (cases:[], otherwise=full) is entry-rejected yet judged as frozen',
      slot: blankSlot,
      criterion: blankCriterion,
      rule: { version: 1, cases: [], otherwise: { points: 5 } },
      points: 5,
      comparator: 'blank_exact',
      entry: { slot_id: 'p1::r', kind: 'blank', state: 'answered', text: 'nope' },
      entryIssues: ['rule_wrong_response_full_marks'],
      judged: 5,
    },
    {
      name: 'a rule that only zeroes one wrong pick still gives several wrong picks full marks',
      slot: selectSlot,
      criterion: selectCriterion(['a', 'b']),
      rule: {
        version: 1,
        cases: [{ when: { picked: { eq: 1 } }, award: { points: 0 } }],
        otherwise: { points: 5 },
      },
      points: 5,
      comparator: 'set_compare',
      entry: { slot_id: 'p1::r', kind: 'select', state: 'answered', item_ids: ['c'] },
      entryIssues: ['rule_wrong_response_full_marks'],
      judged: 0,
    },
    {
      name: 'degenerate select rule likewise',
      slot: selectSlot,
      criterion: selectCriterion(['a']),
      rule: { version: 1, cases: [], otherwise: { points: 5 } },
      points: 5,
      comparator: 'set_compare',
      entry: { slot_id: 'p1::r', kind: 'select', state: 'answered', item_ids: ['b'] },
      entryIssues: ['rule_wrong_response_full_marks'],
      judged: 5,
    },
    {
      name: 'all-or-nothing blank rule passes entry and zeroes the wrong answer',
      slot: blankSlot,
      criterion: blankCriterion,
      rule: {
        version: 1,
        cases: [{ when: { correct: { eq: 1 } }, award: { points: 5 } }],
        otherwise: { points: 0 },
      },
      points: 5,
      comparator: 'blank_exact',
      entry: { slot_id: 'p1::r', kind: 'blank', state: 'answered', text: 'nope' },
      entryIssues: [],
      judged: 0,
    },
    {
      name: 'unknown-otherwise blank rule is not flagged and scores unknown',
      slot: blankSlot,
      criterion: blankCriterion,
      rule: {
        version: 1,
        cases: [{ when: { correct: { eq: 1 } }, award: { points: 5 } }],
        otherwise: { unknown: 'points_not_printed' },
      },
      points: 5,
      comparator: 'blank_exact',
      entry: { slot_id: 'p1::r', kind: 'blank', state: 'answered', text: 'nope' },
      entryIssues: [],
      judged: null,
    },
    {
      name: 'partial-credit select rule passes entry and zeroes the all-wrong pick',
      slot: selectSlot,
      criterion: selectCriterion(['a', 'b']),
      rule: {
        version: 1,
        cases: [
          { when: { hit: { eq: 2 }, wrong: { eq: 0 } }, award: { points: 6 } },
          { when: { hit: { eq: 1 }, wrong: { eq: 0 } }, award: { points: 3 } },
        ],
        otherwise: { points: 0 },
      },
      points: 6,
      comparator: 'set_compare',
      entry: { slot_id: 'p1::r', kind: 'select', state: 'answered', item_ids: ['c'] },
      entryIssues: [],
      judged: 0,
    },
  ];
  for (const row of rows) {
    if (row.slot == null) throw new Error('slot fixture missing');
    const unit = ScoringUnit.parse({
      scoring_unit_id: 'p1::u',
      slot_refs: [row.slot.slot_id],
      material_refs: [],
      evidence_slot_refs: [],
      requires_group_evidence: false,
      criterion: row.criterion,
      points: row.points,
      rule: row.rule,
    });
    const revision = revisionFor({
      slots: [row.slot],
      units: [unit],
      assignments: [
        {
          scoring_unit_ids: ['p1::u'],
          executor: { kind: 'deterministic', comparator: row.comparator },
        },
      ],
    });
    // 共享 barrier 不收窄：存量冻结规则（含错答满分形状）照常通过 validateScoringBasis。
    expect(
      validateScoringBasis(revision.scoring_basis, revision.response_spec, revision.structure),
      row.name,
    ).toEqual([]);
    // 入口加查（submit_question / edit_question / check_bank / 准入）才报新 issue。
    expect(
      wrongResponseFullMarksIssues(revision.scoring_basis).map((issue) => issue.code),
      row.name,
    ).toEqual(row.entryIssues);
    // 判分确定性不变：已发布的退化规则照样按冻结契约判出原分。
    const out = await evaluateSubmissionCore(inputFor(submissionFor([row.entry]), revision));
    const scored = out.record.unit_results[0];
    expect(
      scored?.status === 'scored' ? scored.points_awarded : scored?.pending.reason,
      row.name,
    ).toBe(row.judged);
  }
});
