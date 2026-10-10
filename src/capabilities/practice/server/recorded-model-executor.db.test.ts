import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelExecutorRequest, ModelUnitOutcomeT } from '@/core/schema/assessment';
import { event } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { createRecordedModelExecutor } from './judge/recorded-model-executor';

function request(attempt = 1): ModelExecutorRequest {
  return {
    submission_id: 'submitted-original',
    submission_ids: ['submitted-original'],
    evaluation_group_id: 'group-original',
    revision_id: 'revision-original',
    attempt,
    scoring_unit_id: 'unit-reasoning',
    executor: {
      kind: 'model_executor',
      task_kind: 'AssessmentRuleJudgeTask',
      admitted_slice_id: 'approved-slice',
      max_cost_usd_micros: 1000,
    },
    unit: {
      scoring_unit_id: 'unit-reasoning',
      slot_refs: ['reasoning'],
      material_refs: ['passage'],
      evidence_slot_refs: [],
      requires_group_evidence: false,
      points: 2,
      criterion: {
        kind: 'rule_reference',
        rule_id: 'justify-units',
        statement_md:
          'Explain the conversion, account for direction, and justify the units.\n'.repeat(20),
        source: 'official',
      },
    },
    question_parts: [
      {
        part_id: 'part-original',
        prompt_md:
          'A boat travels downstream at 12 km/h and returns at 8 km/h. Explain the current speed.',
        material_ids: ['passage'],
      },
    ],
    response_slots: [
      { slot_id: 'reasoning', part_id: 'part-original', kind: 'text', math_preview: true },
    ],
    slot_responses: [
      {
        slot_id: 'reasoning',
        kind: 'text',
        text_md:
          'Let b+c=12 and b-c=8. Subtract: 2c=4, so c=2 km/h.\nThe assumption is the same boat speed relative to water.',
        self_confidence: 3,
      },
    ],
    group_evidence: [],
    materials: [
      {
        material_id: 'passage',
        kind: 'plaintext',
        visibility: 'public',
        asset: { asset_id: 'txt_original', digest: `sha256:${'a'.repeat(64)}` },
        content_md: 'Use the same steady current and ignore acceleration.',
      },
    ],
    spent_cost_usd_micros: 0,
  };
}

function scored(taskRunId: string): ModelUnitOutcomeT {
  return {
    kind: 'scored',
    points_awarded: 2,
    matched: { rule_id: 'justify-units', option_ids: [] },
    feedback_md: 'The subtraction isolates the current and retains km/h.',
    confidence: 0.9,
    evidence_citations: [{ slot_id: 'reasoning', quote: '2c=4' }],
    run_refs: [taskRunId],
    cost_usd_micros: 120,
  };
}

describe('formal model execution receipts', () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it('commits a claim before execution and reuses its exact result across candidate rollback', async () => {
    const execute = vi.fn(
      async (_input: ModelExecutorRequest, _signal: AbortSignal | undefined, runId: string) => {
        const claims = await testDb()
          .select()
          .from(event)
          .where(eq(event.action, 'experimental:assessment_model_claim'));
        expect(claims).toHaveLength(1);
        expect(claims[0].payload).toMatchObject({
          planned_task_run_id: runId,
          reserved_cost_usd_micros: 1000,
        });
        return scored(runId);
      },
    );
    const model = createRecordedModelExecutor(testDb(), execute);
    let initial: ModelUnitOutcomeT | undefined;
    await expect(
      testDb().transaction(async () => {
        initial = await model(request());
        throw new Error('candidate insert failed');
      }),
    ).rejects.toThrow('candidate insert failed');
    const replay = await model(request());
    expect(replay).toEqual(initial);
    expect(replay).toMatchObject({ kind: 'scored', cost_usd_micros: 120 });
    expect(execute).toHaveBeenCalledOnce();
    expect(
      await testDb()
        .select()
        .from(event)
        .where(eq(event.action, 'experimental:assessment_model_result')),
    ).toHaveLength(1);
  });

  it('concurrent redelivery holds while the first execution is in flight and never calls twice', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const execute = vi.fn(
      async (_input: ModelExecutorRequest, _signal: AbortSignal | undefined, runId: string) => {
        started();
        await gate;
        return scored(runId);
      },
    );
    const model = createRecordedModelExecutor(testDb(), execute);
    const first = model(request());
    await entered;
    try {
      expect(await model(request())).toMatchObject({
        kind: 'pending',
        cost_usd_micros: 1000,
        pending: { reason: 'infra_failure', retryable: false },
      });
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      release();
    }
    const completed = await first;
    expect(await model(request())).toEqual(completed);
    expect(execute).toHaveBeenCalledOnce();
  });
});
