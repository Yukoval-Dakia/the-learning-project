// Real-Postgres integration tests for the calibration-sample durable operation
// (retained handler, staged core, shared store). Provider execution is replaced
// with a local output stub; every store/event write hits the real database.
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalibrationSampleDispatch } from '@/capabilities/practice/grading/server/calibration-sample-store';
import { resetTestConfig, setTestConfig } from '@/core/config/store';
import { computePaidEffectIdentity } from '@/core/paid-work/protocol/paid-effect-protocol';
import { readPaidEffect } from '@/core/paid-work/server/paid-effect-store';
import { event, paid_effect, question } from '@/db/schema';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV } from '../jobs/judge-calibration-config';
import {
  type CalibrationWorkSetItem,
  buildCalibrationStagedCoreSeams,
  buildCalibrationStoreInput,
  runCalibrationStagedOperation,
} from './calibration-sample-durable-operation';
import {
  JUDGE_CALIBRATION_SAMPLE_ACTION,
  type JudgeCalibrationConfig,
  type JudgeCalibrationSampleDeps,
  freezeCalibrationWorkSetFromCandidates,
  selectJudgeCalibrationCandidates,
} from './judge-calibration-sample-core';

const CFG: JudgeCalibrationConfig = {
  rejudgeProvider: 'anthropic-sub',
  rejudgeModel: 'claude-opus-4-8',
  batchMax: 5,
  windowDays: 7,
};
const scheduledAt = new Date('2026-10-11T22:10:00.000Z');

function semanticOutput(coarse: 'correct' | 'partial'): string {
  return JSON.stringify({
    score: coarse === 'correct' ? 0.9 : 0.5,
    coarse_outcome: coarse,
    confidence: 0.8,
    feedback_md: '方程成立，但需要区分单件与两件总价。'.repeat(30),
    evidence_json: {
      matched_points: ['2x=84'],
      missing_points: coarse === 'partial' ? ['单位'] : [],
    },
  });
}

async function seedJudgedAttempt(
  missingAnswer = false,
): Promise<{ questionId: string; attemptEventId: string; judgeEventId: string }> {
  const db = testDb();
  const createdAt = new Date('2026-10-11T21:10:00.000Z');
  const questionId = createId();
  await db.insert(question).values({
    id: questionId,
    kind: 'short_answer',
    prompt_md: '两件同价商品总计84元，求单件价格并解释方程与单位。'.repeat(30),
    reference_md: '设单件价格为x元，则2x=84，因此x=42元。'.repeat(30),
    rubric_json: {
      criteria: [
        { name: 'equation', weight: 0.6, descriptor: '两件总价与单件价格对应' },
        { name: 'unit', weight: 0.4, descriptor: '单件价格单位为元' },
      ],
      required_points: ['2x=84', '42元'],
    },
    choices_md: null,
    draft_status: null,
    knowledge_ids: [],
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    figures: [],
    image_refs: [],
    structured: null,
    metadata: { source_context: { ambiguity: ['总价不是单价'], paragraphs: ['条件', '推导'] } },
    created_at: createdAt,
    updated_at: createdAt,
    version: 0,
  });
  const attemptEventId = createId();
  await db.insert(event).values({
    id: attemptEventId,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: questionId,
    outcome: 'failure',
    payload: missingAnswer
      ? { answer_image_refs: [] }
      : { answer_md: '2x=84，所以单件价格为42元。'.repeat(30), answer_image_refs: [] },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: createdAt,
  });
  const judgeEventId = createId();
  await db.insert(event).values({
    id: judgeEventId,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'paper_judge',
    action: 'judge',
    subject_kind: 'event',
    subject_id: attemptEventId,
    outcome: 'success',
    payload: {
      cause: {
        primary_category: 'other',
        secondary_categories: [],
        analysis_md: '原始判分保留，不由校准覆盖。'.repeat(30),
        confidence: 0.7,
      },
      coarse_outcome: 'correct',
      score: 0.4,
      judge_route: 'semantic',
      capability_ref: { id: 'semantic', version: '1.0.0' },
      profile_version: '1.0.0',
    },
    caused_by_event_id: attemptEventId,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: createdAt,
  });
  return { questionId, attemptEventId, judgeEventId };
}

function eventsByAction(action: string) {
  return testDb().select().from(event).where(eq(event.action, action));
}

beforeEach(async () => {
  await resetDb();
  setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
});
afterEach(() => {
  resetTestConfig();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function freezeOne() {
  const judgeEventId = (await seedJudgedAttempt()).judgeEventId;
  const candidates = await selectJudgeCalibrationCandidates(testDb(), CFG, scheduledAt);
  const frozen = await freezeCalibrationWorkSetFromCandidates(testDb(), candidates);
  expect(frozen.unprepared).toEqual([]);
  expect(frozen.items).toHaveLength(1);
  const item = frozen.items[0];
  const candidate = candidates[0];
  if (!item || !candidate) throw new Error('seeded candidate was not frozen');
  expect(item.judgeEventId).toBe(judgeEventId);
  return { item, candidate };
}

describe('prepared staged core integration', () => {
  // @invariant data: failed apply recovers from its saved receipt on a later tick without a second provider request
  // @fails-if use the new tick config/clock or plan the entity again after recovery; stored provenance or call count changes
  it('rolls back the domain write and recovers the original receipt on a later model/tick without resend', async () => {
    setTestConfig({ VISION_JUDGE_PROVIDER: 'xiaomi', 'lane.global.provider': 'xiaomi' });
    const { item } = await freezeOne();
    const executedAt = new Date('2026-10-11T22:13:00.000Z');
    const runTaskInner = vi.fn<NonNullable<JudgeCalibrationSampleDeps['runTaskInner']>>(
      async () => ({ text: semanticOutput('partial') }),
    );
    const seams = await buildCalibrationStagedCoreSeams(testDb(), CFG, {
      runTaskInner,
      now: () => executedAt,
    });
    const first = await runStore([item], {
      seams: {
        ...seams,
        applyReceipt: async (...args) => {
          const result = await seams.applyReceipt(...args);
          expect(result.write).toBe('written');
          throw new Error('crash after domain write before application receipt');
        },
      },
    });
    expect(first).toMatchObject({
      kind: 'staged',
      report: { counts: { completedApplyPending: 1 } },
    });
    expect(await eventsByAction(JUDGE_CALIBRATION_SAMPLE_ACTION)).toEqual([]);
    const identity = computePaidEffectIdentity(
      buildCalibrationStoreInput({ item, items: [item], anchor: scheduledAt, cfg: CFG }),
    );
    const before = await readPaidEffect(testDb(), identity);
    expect(before).toMatchObject({
      state: 'receipt_ready',
      application: null,
      applicationAttempts: 1,
      lastApplicationError: 'crash after domain write before application receipt',
    });
    const savedResult = structuredClone(before?.result);
    expect(savedResult).toMatchObject({
      execution: {
        receipt: {
          outcome: {
            config: { rejudgeProvider: CFG.rejudgeProvider, rejudgeModel: CFG.rejudgeModel },
            lane: {
              visionJudgeProviderAtSample: 'xiaomi',
              aiProviderOverrideAtSample: 'xiaomi',
            },
          },
        },
      },
    });
    await testDb()
      .update(question)
      .set({ prompt_md: '恢复前改变题干', version: 3 })
      .where(eq(question.id, item.questionId));
    await testDb()
      .update(event)
      .set({ payload: { answer_md: '恢复前改变作答' } })
      .where(eq(event.id, item.answerEventId));
    setTestConfig({
      VISION_JUDGE_PROVIDER: 'anthropic-sub',
      'lane.global.provider': 'anthropic-sub',
    });
    const laterAnchor = new Date('2026-10-12T22:10:00.000Z');
    const laterCfg = { ...CFG, rejudgeModel: 'later-model', windowDays: 30 };
    const later = await runStore([item], {
      anchor: laterAnchor,
      cfg: laterCfg,
      sampleDeps: { runTaskInner, now: () => laterAnchor },
    });
    expect(later).toMatchObject({
      kind: 'staged',
      report: { counts: { appliedFromReceipt: 1 }, openObligations: [], pendingApplications: [] },
    });
    expect(runTaskInner).toHaveBeenCalledOnce();
    const after = await readPaidEffect(testDb(), identity);
    expect(after?.result).toEqual(savedResult);
    expect(after).toMatchObject({
      state: 'applied',
      application: {
        version: 1,
        effect: identity,
        application: {
          write: 'written',
          domainRef: `${JUDGE_CALIBRATION_SAMPLE_ACTION}:${item.judgeEventId}`,
        },
      },
    });
    const rows = await eventsByAction(JUDGE_CALIBRATION_SAMPLE_ACTION);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      created_at: executedAt,
      payload: {
        sampled_at: executedAt.toISOString(),
        rejudge_model: CFG.rejudgeModel,
        ai_provider_override_at_sample: 'xiaomi',
        vision_judge_provider_at_sample: 'xiaomi',
      },
    });
    expect(await storeRows()).toHaveLength(1);
  });
});

function dispatch(anchor = scheduledAt, deliveryId = 'original-pg-job'): CalibrationSampleDispatch {
  return {
    version: 1,
    scheduledAt: anchor.toISOString(),
    delivery: {
      backend: 'pg-boss',
      deliveryId,
      generation: 0,
      tickId: `sched-judge_calibration_sample-${anchor.toISOString()}`,
    },
  };
}

async function storeRows() {
  return testDb()
    .select()
    .from(paid_effect)
    .where(eq(paid_effect.family, 'judge_calibration_sample'))
    .orderBy(paid_effect.entity_revision, paid_effect.unit, paid_effect.input_digest);
}

function runStore(
  items: readonly CalibrationWorkSetItem[],
  options: {
    anchor?: Date;
    cfg?: JudgeCalibrationConfig;
    deliveryId?: string;
    seams?: Awaited<ReturnType<typeof buildCalibrationStagedCoreSeams>>;
    sampleDeps?: JudgeCalibrationSampleDeps;
    dispatch?: CalibrationSampleDispatch;
  } = {},
) {
  const anchor = options.anchor ?? scheduledAt;
  return runCalibrationStagedOperation(
    { config: options.cfg ?? CFG, resolveProviderFn: () => {}, sampleDeps: options.sampleDeps },
    {
      database: testDb(),
      dispatch: options.dispatch ?? dispatch(anchor, options.deliveryId),
      leaseExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      workSet: { anchor, items },
      seams: options.seams,
    },
  );
}

describe('concrete calibration shared-store consumer', () => {
  // @invariant concurrency: one stored winner fence permits one send across competing deliveries
  // @fails-if admission is read-then-append or delivery mints the effect identity; both providers execute
  it('uses the real row CAS when a second delivery arrives during the first send', async () => {
    const { item } = await freezeOne();
    let release = () => {};
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runTaskInner = vi.fn<NonNullable<JudgeCalibrationSampleDeps['runTaskInner']>>(
      async () => {
        entered();
        await pending;
        return { text: semanticOutput('partial') };
      },
    );
    const first = runStore([item], { deliveryId: 'winner-job', sampleDeps: { runTaskInner } });
    try {
      await started;
      const loser = await runStore([item], {
        deliveryId: 'loser-job',
        sampleDeps: { runTaskInner },
      });
      expect(loser).toMatchObject({ kind: 'staged', report: { counts: { heldUnknownSend: 1 } } });
      const [sending] = await storeRows();
      expect(sending).toMatchObject({
        state: 'sending',
        fence: 1,
        delivery_id: 'winner-job',
        delivery_backend: 'pg-boss',
        send_lease_expires_at: new Date('2099-01-01T00:00:00.000Z'),
      });
    } finally {
      release();
    }
    expect(await first).toMatchObject({ kind: 'staged', report: { counts: { appliedFresh: 1 } } });
    expect(runTaskInner).toHaveBeenCalledOnce();
    expect(await eventsByAction(JUDGE_CALIBRATION_SAMPLE_ACTION)).toHaveLength(1);
    const originalRows = await storeRows();
    expect(
      await runStore([item], { deliveryId: 'third-job', sampleDeps: { runTaskInner } }),
    ).toMatchObject({ kind: 'staged', report: { counts: { appliedReplay: 1 } } });
    expect(await storeRows()).toEqual(originalRows);
    expect(runTaskInner).toHaveBeenCalledOnce();
  });
});
