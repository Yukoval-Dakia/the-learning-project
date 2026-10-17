import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveSubmission } from '@/capabilities/practice/server/assessment/submit';
import {
  createFormalModelExecutor,
  evaluateSubmission,
} from '@/capabilities/practice/server/judge/evaluate-submission';
import { resetTestConfig, setTestConfig } from '@/core/config/store';
import {
  ExecutionPlan,
  ResponseSpec,
  ScoringBasis,
  type ScoringUnitT,
} from '@/core/schema/assessment';
import { ai_task_runs, question } from '@/db/schema';
import { contractIntegrityDigest } from '@/kernel/records/assessment-normalization';
import { publishQuestionGroup } from '@/server/questions/publisher';
import { seedHistoricalAssessmentIssuance } from '../../../tests/fixtures/historical-assessment-issuance';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  currentModelPins,
  registerModelAdmissionSlice,
  retireModelAdmissionSlice,
} from './model-slice-registry';

const NOW = new Date('2026-10-17T00:00:00.000Z');
const EVIDENCE = {
  marking_provenance: 'official' as const,
  verification: { structural_check_passed: true, independent_verification: null },
  model_slice: null,
};

function rubricUnit(): ScoringUnitT {
  return {
    scoring_unit_id: 'u1',
    slot_refs: ['s1'],
    material_refs: [],
    evidence_slot_refs: [],
    requires_group_evidence: false,
    criterion: {
      kind: 'rubric',
      criteria: [{ criterion_id: 'c1', statement_md: 'method', max: 5, allowed_awards: [0, 5] }],
      crossed_out_steps: 'ignore',
    },
    points: 5,
  };
}

async function seedIssuedRubric() {
  const db = testDb();
  const pin = currentModelPins().get('AssessmentRubricJudgeTask');
  if (pin === undefined) throw new Error('rubric pin missing');
  const registered = await registerModelAdmissionSlice(db, {
    subject: 'math',
    response_class: 'free',
    task_kind: 'AssessmentRubricJudgeTask',
    model: pin.model,
    model_version: pin.model_version,
    holdout_evidence_ref: 'evt_holdout',
    admitted_by: 'owner',
  });
  await db.insert(question).values({
    id: 'q-rubric',
    kind: 'short_answer',
    prompt_md: '求值',
    source: 'web_sourced',
    knowledge_ids: [],
    created_at: NOW,
    updated_at: NOW,
  });
  const structure = {
    group_id: 'q-rubric',
    materials: [],
    parts: [{ part_id: 'p1', prompt_md: '求值', material_ids: [] as string[] }],
  };
  const response_spec = ResponseSpec.parse({
    slots: [{ slot_id: 's1', part_id: 'p1', kind: 'open_response' }],
  });
  const scoring_basis = ScoringBasis.parse({
    units: [rubricUnit()],
    aggregation: { kind: 'sum' },
    blank_scores_zero: true,
  });
  const execution_plan = ExecutionPlan.parse({
    plan_version: 1,
    assignments: [
      {
        scoring_unit_ids: ['u1'],
        executor: {
          kind: 'model_executor',
          task_kind: 'AssessmentRubricJudgeTask',
          admitted_slice_id: registered.slice_id,
          max_cost_usd_micros: 1000,
        },
      },
    ],
    escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'human_review' },
  });
  const published = await publishQuestionGroup(db, {
    group_id: 'q-rubric',
    contract: {
      structure,
      response_spec,
      scoring_basis,
      execution_plan,
      integrity_digest: contractIntegrityDigest({
        structure,
        response_spec,
        scoring_basis,
        execution_plan,
      }),
    },
    expectedCurrentRevision: null,
    expectedAdmissionGeneration: null,
    availability: 'general_pool',
    admission: { state: 'admitted', evidence: EVIDENCE },
    actorRef: 'test:grading-slice',
    now: NOW,
  });
  if (published.status !== 'published') throw new Error(published.status);
  const issued = await seedHistoricalAssessmentIssuance(db, {
    group_id: 'q-rubric',
    mode: 'auto_score',
    now: NOW,
  });
  if (issued.status !== 'issued') throw new Error(issued.status);
  const saved = await saveSubmission(db, {
    issuance_id: issued.issuance.issuance_id,
    evaluation_group_id: 'grading-group',
    idempotency_key: 'confirmed-answer',
    response_set: {
      entries: [{ slot_id: 's1', kind: 'open', text_md: 'the method', evidence: [] }],
    },
    now: NOW,
  });
  if (saved.status !== 'saved') throw new Error(saved.status);
  return { db, registered, saved };
}

async function grade(saved: Awaited<ReturnType<typeof seedIssuedRubric>>['saved']) {
  return evaluateSubmission(testDb(), {
    submission_id: saved.submission.submission_id,
    evaluation_group_id: 'grading-group',
    model_executor: createFormalModelExecutor(testDb()),
  });
}

describe('grading re-checks the live admission slice before paying', () => {
  beforeEach(async () => {
    await resetDb();
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('XIAOMI_API_KEY', '');
    vi.stubEnv('OPENCODE_API_KEY', '');
  });

  afterEach(() => {
    resetTestConfig();
    vi.unstubAllEnvs();
  });

  // @invariant grading: an already issued question is not scored by a later unadmitted model override
  // @fails-if the override model grades the issuance or an ai_task_run is written before refusal
  it('withholds an issued question when the task model override is not the admitted slice', async () => {
    const { saved } = await seedIssuedRubric();
    setTestConfig({ 'task.AssessmentRubricJudgeTask.model': 'mimo-v2.6-flash' });
    const result = await grade(saved);
    const unit = result.record.unit_results[0];
    if (unit?.status !== 'pending' || unit.pending.reason !== 'unjudgeable') {
      throw new Error(`expected unjudgeable withhold, got ${JSON.stringify(unit)}`);
    }
    expect(unit.pending.detail).toContain('mimo-v2.6-flash');
    expect(result.record.unit_results.some((item) => item.status === 'scored')).toBe(false);
    expect(await testDb().select({ id: ai_task_runs.id }).from(ai_task_runs)).toEqual([]);
  });

  // @invariant grading: retiring a slice stops automatic scoring of questions already issued under it
  // @fails-if a retired slice still starts a paid grading call or records an automatic score
  it('withholds an issued question after its slice is retired', async () => {
    const { db, registered, saved } = await seedIssuedRubric();
    await retireModelAdmissionSlice(db, registered.slice_id);
    const result = await grade(saved);
    const unit = result.record.unit_results[0];
    if (unit?.status !== 'pending' || unit.pending.reason !== 'unjudgeable') {
      throw new Error(`expected unjudgeable withhold, got ${JSON.stringify(unit)}`);
    }
    expect(unit.pending.detail).toContain('not active');
    expect(result.record.unit_results.some((item) => item.status === 'scored')).toBe(false);
    expect(await testDb().select({ id: ai_task_runs.id }).from(ai_task_runs)).toEqual([]);
  });
});
