// Prepared integration tests. Not executed in this source-only lane.
// The real core and event writes run against Postgres when the parent admits
// this file. Provider execution is replaced with a local output stub.
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestConfig, setTestConfig } from '@/core/config/store';
import { event, knowledge, question } from '@/db/schema';
import {
  calibrationSampleScheduledId,
  runCalibrationSampleTick,
} from '@/server/durable/calibration-sample-family';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { buildJudgeCalibrationSampleHandler } from '../jobs/judge_calibration_sample';
import { JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV } from '../jobs/judge-calibration-config';
import {
  type CalibrationStagedEffectRecord,
  type CalibrationStagedExecutionPort,
  type CalibrationWorkSetItem,
  buildCalibrationSampleOperationPort,
  buildCalibrationStagedCoreSeams,
  computeCalibrationEffectIdentity,
  computeCalibrationFreezeDigest,
  computeCalibrationInputDigest,
  computeCalibrationWorkSetId,
  runCalibrationSampleOperation,
  runCalibrationStagedOperation,
} from './calibration-sample-durable-operation';
import {
  JUDGE_CALIBRATION_RUN_SUMMARY_ACTION,
  JUDGE_CALIBRATION_SAMPLE_ACTION,
  type JudgeCalibrationConfig,
  type JudgeCalibrationSampleDeps,
  freezeCalibrationWorkSetFromCandidates,
  prepareCalibrationRejudgeFace,
  selectJudgeCalibrationCandidates,
} from './judge-calibration-sample-core';

const CFG: JudgeCalibrationConfig = {
  rejudgeProvider: 'anthropic-sub',
  rejudgeModel: 'claude-opus-4-8',
  batchMax: 5,
  windowDays: 7,
};
const scheduledAt = new Date('2026-10-11T22:10:00.000Z');
const request = {
  source: { kind: 'dbos', workflowId: calibrationSampleScheduledId(scheduledAt), scheduledAt },
} as const;

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

async function seedJudgedAttempt(missingAnswer = false): Promise<string> {
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
  return judgeEventId;
}

function eventsByAction(action: string) {
  return testDb().select().from(event).where(eq(event.action, action));
}
function allEvents() {
  return testDb().select().from(event).orderBy(event.id);
}
function sampleDeps(runTaskInner: () => Promise<{ text: string; task_run_id?: string }>) {
  return { runTaskInner, now: () => scheduledAt };
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

describe('retained calibration operation integration', () => {
  // @invariant data: a disabled retained handler cannot call the provider or mutate history
  // @fails-if bypass the kill switch; the stub runs or new observation rows appear
  it('disabled retained handler leaves seeded history unchanged', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: false });
    await seedJudgedAttempt();
    const before = await allEvents();
    const runTaskInner = vi.fn(async () => ({ text: semanticOutput('correct') }));
    await buildJudgeCalibrationSampleHandler(testDb(), {
      config: CFG,
      resolveProviderFn: () => {},
      sampleDeps: sampleDeps(runTaskInner),
    })([]);
    expect(runTaskInner).not.toHaveBeenCalled();
    expect(await allEvents()).toEqual(before);
  });

  // @invariant data: the extracted operation appends only observations and preserves original judgments
  // @fails-if overwrite original events or miscount missing inputs; history or batch counts differ
  it('real core preserves history across agreement, disagreement and missing input', async () => {
    const first = await seedJudgedAttempt();
    const second = await seedJudgedAttempt();
    await seedJudgedAttempt(true);
    const before = await allEvents();
    let calls = 0;
    const runTaskInner = vi.fn(async () => ({
      task_run_id: `local-run-${++calls}`,
      text: semanticOutput(calls === 1 ? 'correct' : 'partial'),
    }));
    const outcome = await runCalibrationSampleOperation(
      testDb(),
      { kind: 'pg-boss', jobId: 'job-1' },
      {
        config: CFG,
        resolveProviderFn: () => {},
        sampleDeps: sampleDeps(runTaskInner),
      },
    );
    expect(outcome).toMatchObject({
      kind: 'sampled',
      result: {
        sampled: 2,
        agreed: 1,
        disagreed: 1,
        skipped: 0,
        skipped_missing_input: 1,
        skipped_unsupported: 0,
        errors: 0,
      },
    });
    expect(runTaskInner).toHaveBeenCalledTimes(2);
    const after = await allEvents();
    expect(after.filter((row) => before.some((original) => original.id === row.id))).toEqual(
      before,
    );
    const samples = await eventsByAction(JUDGE_CALIBRATION_SAMPLE_ACTION);
    expect(samples.map((row) => row.caused_by_event_id).sort()).toEqual([first, second].sort());
    const summaries = await eventsByAction(JUDGE_CALIBRATION_RUN_SUMMARY_ACTION);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.subject_id).toBe('judge_calibration_run:2026-10-11T22:10:00.000Z');
    expect(after).toHaveLength(before.length + 3);
  });

  // @invariant data: the live retained consumer runs the real core with the same report-only writes
  // @fails-if disconnect the handler from the operation; no sample or summary is written
  it('enabled retained handler appends one sample and one summary through the real core', async () => {
    const judgeId = await seedJudgedAttempt();
    const before = await allEvents();
    const runTaskInner = vi.fn(async () => ({
      task_run_id: 'retained-run',
      text: semanticOutput('correct'),
    }));
    await buildJudgeCalibrationSampleHandler(testDb(), {
      config: CFG,
      resolveProviderFn: () => {},
      sampleDeps: sampleDeps(runTaskInner),
    })([]);
    expect(runTaskInner).toHaveBeenCalledTimes(1);
    const samples = await eventsByAction(JUDGE_CALIBRATION_SAMPLE_ACTION);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.caused_by_event_id).toBe(judgeId);
    expect(await eventsByAction(JUDGE_CALIBRATION_RUN_SUMMARY_ACTION)).toHaveLength(1);
    const after = await allEvents();
    expect(after.filter((row) => before.some((original) => original.id === row.id))).toEqual(
      before,
    );
    expect(after).toHaveLength(before.length + 2);
  });
});

describe('gate-only DBOS candidate integration', () => {
  // @invariant data: disabled candidate ticks cannot invoke paid work or alter seeded history
  // @fails-if add paid work to the disabled path; the runner or database assertions fail
  it('disabled candidate leaves every seeded event unchanged', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: false });
    await seedJudgedAttempt();
    const before = await allEvents();
    const runTaskInner = vi.fn(async () => ({ text: semanticOutput('correct') }));
    const operation = buildCalibrationSampleOperationPort({
      config: CFG,
      resolveProviderFn: () => {},
      sampleDeps: sampleDeps(runTaskInner),
    });
    expect((await runCalibrationSampleTick(request, { operation })).outcome.kind).toBe('disabled');
    expect(runTaskInner).not.toHaveBeenCalled();
    expect(await allEvents()).toEqual(before);
  });

  // @invariant data: enabled repeated ticks remain held without a durable pre-spend claim
  // @fails-if authorize a paid batch; runner calls or observation writes appear
  it('enabled candidate stays held across fresh invocations without any writes', async () => {
    await seedJudgedAttempt();
    const before = await allEvents();
    const runTaskInner = vi.fn(async () => ({ text: semanticOutput('correct') }));
    for (let invocation = 0; invocation < 2; invocation += 1) {
      const operation = buildCalibrationSampleOperationPort({
        config: CFG,
        resolveProviderFn: () => {},
        sampleDeps: sampleDeps(runTaskInner),
      });
      expect(await runCalibrationSampleTick(request, { operation })).toMatchObject({
        tick: { workflowId: request.source.workflowId, scheduledAt },
        outcome: { kind: 'held' },
      });
    }
    expect(runTaskInner).not.toHaveBeenCalled();
    expect(await allEvents()).toEqual(before);
  });
});

// The record port below is an isolated test double. It does not test or
// implement lane B's durable store, fencing, or concurrency guarantee.
function stagedTestPort(rows: CalibrationStagedEffectRecord[]): CalibrationStagedExecutionPort {
  return {
    loadFamilyRecords: async () => [...rows],
    reserveIntent: async (record) => {
      const winner = rows.find((row) => row.effectId === record.effectId);
      if (winner) return { status: 'lost', winner };
      rows.push(record);
      return { status: 'reserved' };
    },
    appendRecord: async (record) => {
      rows.push(record);
    },
  };
}

async function freezeOne() {
  const judgeEventId = await seedJudgedAttempt();
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

function identityFor(item: CalibrationWorkSetItem) {
  return computeCalibrationEffectIdentity({
    workSetId: computeCalibrationWorkSetId({ anchor: scheduledAt, cfg: CFG }),
    freezeDigest: computeCalibrationFreezeDigest([item]),
    item,
    cfg: CFG,
  });
}

describe('prepared staged core integration', () => {
  // @invariant data: mutable question/answer/profile edits cannot alter a frozen paid request
  // @fails-if execution re-reads rows or hashes only the answer; the runner sees edited material
  it('freezes real rows then executes the original input after question/answer/profile/model/clock changes', async () => {
    const { item, candidate } = await freezeOne();
    const digest = computeCalibrationInputDigest(item);
    const saved: CalibrationWorkSetItem = JSON.parse(JSON.stringify(item));
    expect(computeCalibrationInputDigest(saved)).toBe(digest);
    const knowledgeId = createId();
    await testDb().insert(knowledge).values({
      id: knowledgeId,
      name: '校准冻结后的数学知识点',
      domain: 'math',
      created_at: scheduledAt,
      updated_at: scheduledAt,
    });
    await testDb()
      .update(question)
      .set({
        prompt_md: '后来编辑的题干，条件已改变。'.repeat(30),
        reference_md: '后来编辑的参考答案。',
        knowledge_ids: [knowledgeId],
        rubric_json: { criteria: [{ name: 'changed', weight: 1, descriptor: '新评分点' }] },
        metadata: { changed_after_freeze: true },
        version: 1,
      })
      .where(eq(question.id, item.questionId));
    await testDb()
      .update(event)
      .set({ payload: { answer_md: '后来改变的作答', answer_image_refs: [] } })
      .where(eq(event.id, item.answerEventId));
    const changed = await prepareCalibrationRejudgeFace(testDb(), candidate);
    expect(changed.kind).toBe('prepared');
    if (changed.kind !== 'prepared')
      throw new Error('edited candidate should remain reconstructable');
    expect(changed.face.subjectProfile.id).toBe('math');
    expect(changed.face.subjectProfile.id).not.toBe(item.subjectProfile.id);

    setTestConfig({ VISION_JUDGE_PROVIDER: 'xiaomi', 'lane.global.provider': 'xiaomi' });
    let clock = new Date('2026-10-11T22:14:00.000Z');
    const cfg = { ...CFG };
    const runTaskInner = vi.fn<NonNullable<JudgeCalibrationSampleDeps['runTaskInner']>>(
      async () => {
        setTestConfig({
          VISION_JUDGE_PROVIDER: 'anthropic-sub',
          'lane.global.provider': 'anthropic-sub',
        });
        clock = new Date('2026-10-12T22:14:00.000Z');
        return { text: semanticOutput('partial') };
      },
    );
    const seams = await buildCalibrationStagedCoreSeams(testDb(), cfg, {
      runTaskInner,
      now: () => clock,
    });
    cfg.rejudgeModel = 'later-model';
    const identity = identityFor(saved);
    const execution = await seams.executeItem(saved, identity, { anchor: scheduledAt });
    expect(execution.kind).toBe('sent');
    if (execution.kind !== 'sent') throw new Error('expected semantic receipt');
    expect(execution.receipt.outcome).toMatchObject({
      prepared_input: {
        question: saved.question,
        subject_profile: saved.subjectProfile,
        answer_md: saved.answerMd,
      },
      config: CFG,
      executed_at: '2026-10-11T22:14:00.000Z',
      lane: { visionJudgeProviderAtSample: 'xiaomi', aiProviderOverrideAtSample: 'xiaomi' },
    });
    expect(runTaskInner).toHaveBeenCalledOnce();
    expect(runTaskInner.mock.calls[0]).toEqual([
      'SemanticJudgeTask',
      expect.objectContaining({
        answer: { content: saved.answerMd },
        question: expect.objectContaining({ prompt_md: saved.question.prompt_md }),
      }),
      expect.objectContaining({
        override: { provider: CFG.rejudgeProvider, model: CFG.rejudgeModel },
      }),
    ]);
    const later = await buildCalibrationStagedCoreSeams(testDb(), {
      ...CFG,
      rejudgeModel: 'later-model',
    });
    expect(await later.applyReceipt(execution.receipt, identity, { anchor: clock })).toMatchObject({
      write: 'written',
    });
    const rows = await eventsByAction(JUDGE_CALIBRATION_SAMPLE_ACTION);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      created_at: new Date('2026-10-11T22:14:00.000Z'),
      payload: {
        sampled_at: '2026-10-11T22:14:00.000Z',
        rejudge_model: CFG.rejudgeModel,
        ai_provider_override_at_sample: 'xiaomi',
        vision_judge_provider_at_sample: 'xiaomi',
      },
    });
  });

  // @invariant data: failed apply recovers from its saved receipt on a later tick without a second provider request
  // @fails-if use the new tick config/clock or plan the entity again after recovery; stored provenance or call count changes
  it('retains an apply failure then writes the original receipt on a later model/tick without resend', async () => {
    const { item } = await freezeOne();
    const executedAt = new Date('2026-10-11T22:13:00.000Z');
    const runTaskInner = vi.fn<NonNullable<JudgeCalibrationSampleDeps['runTaskInner']>>(
      async () => ({ text: semanticOutput('partial') }),
    );
    const seams = await buildCalibrationStagedCoreSeams(testDb(), CFG, {
      runTaskInner,
      now: () => executedAt,
    });
    const records: CalibrationStagedEffectRecord[] = [];
    const port = stagedTestPort(records);
    const first = await runCalibrationStagedOperation(
      { config: CFG, resolveProviderFn: () => {} },
      {
        port,
        workSet: { anchor: scheduledAt, items: [item] },
        executeItem: seams.executeItem,
        applyReceipt: async () => {
          throw new Error('injected domain apply failure');
        },
      },
    );
    expect(first).toMatchObject({
      kind: 'staged',
      report: { counts: { completedApplyPending: 1 } },
    });
    expect(await eventsByAction(JUDGE_CALIBRATION_SAMPLE_ACTION)).toEqual([]);
    expect(records.map((row) => row.stage)).toEqual(['intent', 'completed']);
    const originalReceipt = JSON.stringify(records[1]?.receipt);
    const laterAnchor = new Date('2026-10-12T22:10:00.000Z');
    const laterCfg = { ...CFG, rejudgeModel: 'new-model', batchMax: 2, windowDays: 30 };
    setTestConfig({
      VISION_JUDGE_PROVIDER: 'anthropic-sub',
      'lane.global.provider': 'anthropic-sub',
    });
    const laterSeams = await buildCalibrationStagedCoreSeams(testDb(), laterCfg, {
      runTaskInner,
      now: () => laterAnchor,
    });
    const later = await runCalibrationStagedOperation(
      { config: laterCfg, resolveProviderFn: () => {} },
      {
        port,
        workSet: { anchor: laterAnchor, items: [item] },
        executeItem: laterSeams.executeItem,
        applyReceipt: laterSeams.applyReceipt,
      },
    );
    expect(later).toMatchObject({
      kind: 'staged',
      report: { pendingApplications: [], counts: { appliedFromReceipt: 1 } },
    });
    expect(runTaskInner).toHaveBeenCalledOnce();
    expect(records.map((row) => row.stage)).toEqual(['intent', 'completed', 'applied']);
    expect(JSON.stringify(records[2]?.receipt)).toBe(originalReceipt);
    expect(records[2]?.recordedAt).toBe(scheduledAt.toISOString());
    const rows = await eventsByAction(JUDGE_CALIBRATION_SAMPLE_ACTION);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      created_at: executedAt,
      payload: { rejudge_model: CFG.rejudgeModel, sampled_at: executedAt.toISOString() },
    });
  });
});
