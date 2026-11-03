import { afterEach, describe, expect, it } from 'vitest';
import { resetTestConfig, setTestConfig } from '@/core/config/store';
import { currentModelPins } from '@/server/assessment/model-slice-registry';
import { defaultPresentation } from './presentation';
import { ResponseSpec } from './response';
import type { PublishedQuestionRevisionT } from './revision';
import { ScoringUnit, type ScoringUnitT } from './scoring';
import {
  type AdmittedModelSliceT,
  type ModelAdmissionContext,
  decideAutomaticServing,
} from './serving-admission';

const NOW = '2026-10-17T00:00:00.000Z';

function rubricUnit(): ScoringUnitT {
  return ScoringUnit.parse({
    scoring_unit_id: 'u1',
    slot_refs: ['s1'],
    criterion: {
      kind: 'rubric',
      criteria: [{ criterion_id: 'c1', statement_md: 'method', max: 5, allowed_awards: [0, 5] }],
      crossed_out_steps: 'ignore',
    },
    points: 5,
  });
}

function revisionFor(
  unit: ScoringUnitT,
  taskKind: string,
  sliceId: string,
): PublishedQuestionRevisionT {
  const structure = {
    group_id: 'g1',
    materials: [],
    parts: [{ part_id: 'p1', prompt_md: '求值', material_ids: [] as string[] }],
  };
  const response_spec = ResponseSpec.parse({
    slots:
      unit.criterion.kind === 'blank_key'
        ? [{ slot_id: 's1', part_id: 'p1', kind: 'blank', format: 'text' }]
        : [{ slot_id: 's1', part_id: 'p1', kind: 'open_response' }],
  });
  const scoring_basis = {
    units: [unit],
    aggregation: { kind: 'sum' as const },
    blank_scores_zero: true,
  };
  const presentation =
    unit.criterion.kind === 'blank_key'
      ? defaultPresentation(structure, response_spec, scoring_basis)
      : null;
  return {
    revision_id: 'rev-1',
    group_id: 'g1',
    revision_ordinal: 1,
    integrity_digest: 'sha256:test',
    structure,
    response_spec,
    scoring_basis,
    execution_plan: {
      plan_version: 1,
      assignments: [
        {
          scoring_unit_ids: ['u1'],
          executor: {
            kind: 'model_executor',
            task_kind: taskKind,
            admitted_slice_id: sliceId,
          },
        },
      ],
      escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'human_review' },
    },
    ...(presentation != null ? { presentation } : {}),
    published_at: NOW,
    supersedes_revision_id: null,
  };
}

function slice(
  overrides: Partial<AdmittedModelSliceT> &
    Pick<
      AdmittedModelSliceT,
      'slice_id' | 'subject' | 'response_class' | 'task_kind' | 'model' | 'model_version'
    >,
): AdmittedModelSliceT {
  return {
    holdout_evidence_ref: 'evt_holdout',
    admitted_at: NOW,
    admitted_by: 'owner',
    ...overrides,
  };
}

function admission(
  row: AdmittedModelSliceT,
  models: ModelAdmissionContext['current_models'],
): ModelAdmissionContext {
  return { slices: new Map([[row.slice_id, row]]), current_models: models };
}

describe('automatic serving model gate', () => {
  afterEach(() => {
    resetTestConfig();
  });

  // @invariant grading: a model slice serves only its own subject; a missing subject stays withheld
  // @fails-if compare only task, response class, and pin; a physics question citing a math slice is admitted
  it('withholds a slice whose subject is not the question subject', () => {
    const pins = currentModelPins();
    const rubric = pins.get('AssessmentRubricJudgeTask');
    if (rubric === undefined) throw new Error('rubric pin missing');
    const row = slice({
      slice_id: 'slice_math',
      subject: 'math',
      response_class: 'free',
      task_kind: 'AssessmentRubricJudgeTask',
      model: rubric.model,
      model_version: rubric.model_version,
    });
    const revision = revisionFor(rubricUnit(), 'AssessmentRubricJudgeTask', row.slice_id);
    const context = admission(row, pins);
    expect(decideAutomaticServing(revision, ['p1'], context, 'math')).toEqual({ kind: 'admitted' });
    expect(decideAutomaticServing(revision, ['p1'], context, 'physics')).toMatchObject({
      kind: 'unavailable',
      reason: 'model_admission_unavailable',
      detail: expect.stringContaining("not 'physics'"),
    });
    expect(decideAutomaticServing(revision, ['p1'], context, null)).toMatchObject({
      kind: 'unavailable',
      reason: 'model_admission_unavailable',
      detail: expect.stringContaining('unresolved'),
    });
  });

  // @invariant grading: a blank unit Jev cannot judge is withheld instead of issued into a permanent pending
  // @fails-if admit every blank_key on a Jev slice; a text key without equivalence would be served
  it('withholds a blank unit that is not a text key with a declared equivalence domain', () => {
    const pins = currentModelPins();
    const jev = pins.get('JevScoringDecisionTask');
    if (jev === undefined) throw new Error('Jev pin missing');
    const row = slice({
      slice_id: 'slice_blank',
      subject: 'math',
      response_class: 'blank',
      task_kind: 'JevScoringDecisionTask',
      model: jev.model,
      model_version: jev.model_version,
    });
    const withoutEquivalence = ScoringUnit.parse({
      scoring_unit_id: 'u1',
      slot_refs: ['s1'],
      criterion: {
        kind: 'blank_key',
        key: { kind: 'text', accepted: ['2'], normalization: { version: 'blank-norm-v1' } },
      },
      points: 2,
      rule: {
        version: 1,
        cases: [{ when: { correct: { eq: 1 } }, award: { points: 2 } }],
        otherwise: { points: 0 },
      },
    });
    const withheld = decideAutomaticServing(
      revisionFor(withoutEquivalence, 'JevScoringDecisionTask', row.slice_id),
      ['p1'],
      admission(row, pins),
      'math',
    );
    expect(withheld).toMatchObject({
      kind: 'unavailable',
      reason: 'model_admission_unavailable',
      detail: expect.stringContaining('not Jev-expressible'),
    });

    const withEquivalence = ScoringUnit.parse({
      ...withoutEquivalence,
      criterion: {
        kind: 'blank_key',
        key: {
          kind: 'text',
          accepted: ['2'],
          normalization: { version: 'blank-norm-v1' },
          equivalence: { domain_md: 'integer value', meaning_md: 'the same integer' },
        },
      },
    });
    expect(
      decideAutomaticServing(
        revisionFor(withEquivalence, 'JevScoringDecisionTask', row.slice_id),
        ['p1'],
        admission(row, pins),
        'math',
      ),
    ).toEqual({ kind: 'admitted' });
  });

  // @invariant grading: the serving pin is the model that will actually run, so a task model override cannot grade under another slice
  // @fails-if read only the registry defaultModel; a mimo-v2.5 slice stays admitted while the task override selects another model
  it('withholds a slice when task.<kind>.model selects a different model', () => {
    const before = currentModelPins().get('AssessmentRubricJudgeTask');
    if (before === undefined) throw new Error('rubric pin missing');
    const row = slice({
      slice_id: 'slice_rubric',
      subject: 'math',
      response_class: 'free',
      task_kind: 'AssessmentRubricJudgeTask',
      model: before.model,
      model_version: before.model_version,
    });
    const revision = revisionFor(rubricUnit(), 'AssessmentRubricJudgeTask', row.slice_id);
    expect(
      decideAutomaticServing(revision, ['p1'], admission(row, currentModelPins()), 'math'),
    ).toEqual({ kind: 'admitted' });

    setTestConfig({ 'task.AssessmentRubricJudgeTask.model': 'mimo-v2.6-flash' });
    const after = currentModelPins();
    expect(after.get('AssessmentRubricJudgeTask')?.model).toBe('mimo-v2.6-flash');
    expect(decideAutomaticServing(revision, ['p1'], admission(row, after), 'math')).toMatchObject({
      kind: 'unavailable',
      reason: 'model_admission_unavailable',
      detail: expect.stringContaining('mimo-v2.6-flash'),
    });
  });
});
