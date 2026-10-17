import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalHash } from '@/core/migration/canonical';
import {
  ExecutionPlan,
  ResponseSpec,
  ScoringBasis,
  type ScoringUnitT,
} from '@/core/schema/assessment';
import {
  ai_task_runs,
  knowledge,
  model_admission_slice,
  question,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import {
  ModelSliceRegistrationError,
  currentModelPins,
  registerModelAdmissionSlice,
  retireModelAdmissionSlice,
} from '@/server/assessment/model-slice-registry';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runModelSliceAdmission } from './model_slice_admission_run';

const NOW = new Date('2026-10-17T00:00:00.000Z');

function jevPin() {
  const pin = currentModelPins().get('JevScoringDecisionTask');
  if (pin === undefined) throw new Error('Jev pin missing');
  return pin;
}

function unit(statement: string): ScoringUnitT {
  return {
    scoring_unit_id: 'u1',
    slot_refs: ['s1'],
    material_refs: [],
    evidence_slot_refs: [],
    requires_group_evidence: false,
    criterion: {
      kind: 'rule_reference',
      rule_id: 'r1',
      statement_md: statement,
      source: 'official',
    },
    points: 1,
  };
}

function holdoutItem(itemId: string, revisionId: string, statement: string) {
  return {
    item_id: itemId,
    revision_id: revisionId,
    unit: unit(statement),
    question_parts: [{ part_id: 'p1', prompt_md: 'solve', material_ids: [] as string[] }],
    response_slots: [{ slot_id: 's1', part_id: 'p1', kind: 'open_response' as const }],
    slot_responses: [{ slot_id: 's1', kind: 'open' as const, text_md: 'answer' }],
    group_evidence: [],
    materials: [],
    reference_points: 1,
  };
}

function payload(runId: string, items: ReturnType<typeof holdoutItem>[]) {
  const pin = jevPin();
  return {
    run_id: runId,
    slice: {
      subject: 'math',
      response_class: 'free' as const,
      task_kind: 'JevScoringDecisionTask',
      model: pin.model,
      model_version: pin.model_version,
    },
    holdout_digest: `sha256:${canonicalHash(items)}`,
    items,
    per_item_max_cost_usd_micros: 1,
    admitted_by: 'owner',
  };
}

async function seedRevision(statement: string) {
  const db = testDb();
  await db.insert(knowledge).values({
    id: 'k-math',
    name: 'algebra',
    domain: 'math',
    created_at: NOW,
    updated_at: NOW,
  });
  await db.insert(question).values({
    id: 'q-math',
    kind: 'short_answer',
    prompt_md: 'solve',
    source: 'web_sourced',
    knowledge_ids: ['k-math'],
    created_at: NOW,
    updated_at: NOW,
  });
  const basis = ScoringBasis.parse({
    units: [unit(statement)],
    aggregation: { kind: 'sum' },
    blank_scores_zero: true,
  });
  await db.insert(question_revision).values({
    revision_id: 'rev-math',
    group_id: 'q-math',
    revision_ordinal: 1,
    integrity_digest: 'sha256:test',
    structure: {
      group_id: 'q-math',
      materials: [],
      parts: [{ part_id: 'p1', prompt_md: 'solve', material_ids: [] }],
    },
    response_spec: ResponseSpec.parse({
      slots: [{ slot_id: 's1', part_id: 'p1', kind: 'open_response' }],
    }),
    scoring_basis: basis,
    execution_plan: ExecutionPlan.parse({
      plan_version: 1,
      assignments: [
        {
          scoring_unit_ids: ['u1'],
          executor: {
            kind: 'model_executor',
            task_kind: 'JevScoringDecisionTask',
            admitted_slice_id: null,
          },
        },
      ],
      escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'human_review' },
    }),
    availability: 'general_pool',
    published_at: NOW,
  });
}

async function expectNoPaidRuns() {
  const runs = await testDb().select({ id: ai_task_runs.id }).from(ai_task_runs);
  expect(runs).toEqual([]);
}

describe('model slice admission pre-paid refusals', () => {
  beforeEach(async () => {
    await resetDb();
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('XIAOMI_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // @invariant idempotency: an active or retired slice is refused before any model call
  // @fails-if the pre-check misses the row and the job continues into the paid loop or a raw unique violation
  it('refuses an existing slice before any paid call', async () => {
    const db = testDb();
    const pin = jevPin();
    const registered = await registerModelAdmissionSlice(db, {
      subject: 'math',
      response_class: 'free',
      task_kind: 'JevScoringDecisionTask',
      model: pin.model,
      model_version: pin.model_version,
      holdout_evidence_ref: 'evt_already',
      admitted_by: 'owner',
    });
    const active = runModelSliceAdmission(
      db,
      payload('run-again', [holdoutItem('i1', 'rev-math', 'award')]),
    );
    await expect(active).rejects.toBeInstanceOf(ModelSliceRegistrationError);
    await expect(active).rejects.toMatchObject({ code: 'slice_conflict' });
    await expectNoPaidRuns();

    await retireModelAdmissionSlice(db, registered.slice_id);
    const retired = runModelSliceAdmission(
      db,
      payload('run-retired', [holdoutItem('i1', 'rev-math', 'award')]),
    );
    await expect(retired).rejects.toMatchObject({ code: 'slice_retired' });
    await expectNoPaidRuns();
  });

  // @invariant idempotency: reusing a run_id whose stored evidence failed does not admit and does not pay again
  // @fails-if ignore the existing event and register from the new verdict, or enter the paid loop
  it('does not admit or pay when the stored evidence for the run id failed', async () => {
    const db = testDb();
    const pin = jevPin();
    const runId = 'run-failed-first';
    await writeEvent(db, {
      id: `evt_model_slice_admission_${runId}`,
      actor_kind: 'system',
      actor_ref: 'practice:model_slice_admission_run',
      action: 'experimental:model_slice_admission_run',
      subject_kind: 'model_admission_slice',
      subject_id: 'slice_previous',
      outcome: 'failed',
      payload: {
        version: 1,
        dry_run: false,
        items: [{ agreed: false }],
        agreement_ratio: 0,
        severe_errors: 0,
        known_cost_usd_micros: 0,
        unknown_cost_items: 0,
        failures: ['agreement_ratio 0 < 0.9'],
      },
      created_at: NOW,
      ingest_at: NOW,
    });
    const summary = await runModelSliceAdmission(
      db,
      payload(runId, [holdoutItem('i1', 'rev-math', 'award')]),
    );
    expect(summary.admitted).toBe(false);
    expect(summary.passed).toBe(false);
    expect(summary.failures).toContain('agreement_ratio 0 < 0.9');
    const slices = await db.select().from(model_admission_slice);
    expect(slices).toEqual([]);
    await expectNoPaidRuns();
    expect(pin.model).toBeTruthy();
  });

  // @invariant grading: a holdout unit that is not the revision's frozen scoring unit is refused before any model call
  // @fails-if skip the frozen-unit comparison and start the paid loop; ai_task_runs would gain a row or the error would be a later refusal
  it('refuses a holdout unit that does not match the frozen scoring basis', async () => {
    const db = testDb();
    await seedRevision('award full marks for the printed method');
    const items = Array.from({ length: 30 }, (_, index) =>
      holdoutItem(`i${index}`, 'rev-math', 'a different statement than the frozen unit'),
    );
    await expect(runModelSliceAdmission(db, payload('run-basis', items))).rejects.toThrow(
      /does not match the frozen scoring basis/,
    );
    await expectNoPaidRuns();
    const slices = await db
      .select({ id: model_admission_slice.slice_id })
      .from(model_admission_slice)
      .where(eq(model_admission_slice.subject, 'math'));
    expect(slices).toEqual([]);
  });
});
