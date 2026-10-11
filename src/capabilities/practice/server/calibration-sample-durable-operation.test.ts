// YUK-1355 — calibration-sample durable operation boundary, unit tests.
// The extracted operation must preserve the retained handler's contract
// verbatim: default-OFF gate, bare fail-loud pre-flight outside the batch
// error hook, lazy core seam, backend-visible failure rethrow, and the
// dbos-source fixed tick clock.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetTestConfig, setTestConfig } from '@/core/config/store';
import { type Db, db } from '@/db/client';
import { writeEvent } from '@/kernel/events';
import { mathProfile } from '@/subjects/math/profile';
import { resolveSubjectProfile } from '@/subjects/profile';
import { JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV } from '../jobs/judge-calibration-config';
import {
  type CalibrationEffectIdentity,
  type CalibrationItemReceipt,
  type CalibrationWorkSetItem,
  buildCalibrationStagedCoreSeams,
  computeCalibrationEffectId,
  computeCalibrationEffectIdentity,
  computeCalibrationEntityKey,
  computeCalibrationFreezeDigest,
  computeCalibrationInputDigest,
  computeCalibrationWorkSetId,
  readCalibrationSampleGate,
  runCalibrationSampleOperation,
  runCalibrationStagedOperation,
} from './calibration-sample-durable-operation';
import { judgeAnswer, unsupportedResult } from './judge/question-contract';
import type {
  JudgeCalibrationConfig,
  JudgeCalibrationRejudgeFace,
  JudgeCalibrationSampleDeps,
  JudgeCalibrationSampleResult,
} from './judge-calibration-sample-core';

const CFG: JudgeCalibrationConfig = {
  rejudgeProvider: 'anthropic-sub',
  rejudgeModel: 'claude-opus-4-8',
  batchMax: 5,
  windowDays: 7,
};

const RESULT: JudgeCalibrationSampleResult = {
  sampled: 1,
  agreed: 1,
  disagreed: 0,
  skipped: 0,
  skipped_missing_input: 0,
  skipped_unsupported: 0,
  errors: 0,
};

const preparationRows = vi.hoisted((): { rows: unknown[][] } => ({ rows: [] }));
vi.mock('@/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => {
          const row = preparationRows.rows.shift();
          if (!row) throw new Error('unexpected live business-row query');
          return row;
        },
      }),
    }),
  },
}));
vi.mock('@/kernel/events', () => ({ writeEvent: vi.fn() }));

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(writeEvent).mockReset();
  preparationRows.rows = [];
});
afterEach(() => {
  resetTestConfig();
  vi.restoreAllMocks();
});

describe('readCalibrationSampleGate', () => {
  // @invariant data: the default disabled gate reads no config and starts no paid work
  // @fails-if read config before the flag; the throwing config getter fails
  it('default OFF — disabled without touching config, pre-flight or core', async () => {
    resetTestConfig();
    vi.stubEnv(JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV, undefined);
    const deps = {
      get config(): JudgeCalibrationConfig {
        throw new Error('config must not be read when disabled');
      },
      resolveProviderFn: () => {
        throw new Error('preflight must not run when disabled');
      },
      runSampleFn: () => {
        throw new Error('core must not run when disabled');
      },
    };
    // @fails-if the gate eagerly reads config or pre-flights while OFF: throws here
    const gate = await readCalibrationSampleGate(deps);
    expect(gate).toEqual({ kind: 'disabled', flagEnv: undefined });
  });

  // @invariant data: sampling preflights the selected second lane before paid execution
  // @fails-if remove the preflight; missing lane configuration cannot stop the batch
  it('enabled — reads config and runs the bare pre-flight with the pinned lane', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const resolveProviderFn = vi.fn();
    const gate = await readCalibrationSampleGate({ config: CFG, resolveProviderFn });
    expect(gate).toEqual({ kind: 'enabled', cfg: CFG });
    // @invariant the second lane is pre-flighted exactly once, provider-pinned
    expect(resolveProviderFn).toHaveBeenCalledTimes(1);
    expect(resolveProviderFn).toHaveBeenCalledWith('SemanticJudgeTask', {
      provider: CFG.rejudgeProvider,
      model: CFG.rejudgeModel,
    });
  });

  // @invariant data: a dead second lane is a visible failure instead of fallback spend
  // @fails-if catch the preflight exception; the gate resolves and permits paid work
  it('pre-flight failure is loud — the throw propagates bare', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const resolveProviderFn = () => {
      throw new Error('missing CLAUDE_CODE_OAUTH_TOKEN');
    };
    // @fails-if the gate swallows the pre-flight throw: the dead lane goes silent
    await expect(readCalibrationSampleGate({ config: CFG, resolveProviderFn })).rejects.toThrow(
      'missing CLAUDE_CODE_OAUTH_TOKEN',
    );
  });
});

describe('runCalibrationSampleOperation', () => {
  // @invariant data: disabled sampling executes no paid batch
  // @fails-if bypass the flag in the operation; runSampleFn is invoked
  it('disabled — reports via hook, never invokes the core', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: false });
    const runSampleFn = vi.fn();
    const onDisabled = vi.fn();
    const outcome = await runCalibrationSampleOperation(
      db,
      { kind: 'pg-boss', jobId: 'job-1' },
      { runSampleFn },
      { onDisabled },
    );
    expect(outcome).toEqual({ kind: 'disabled', flagEnv: undefined });
    // @invariant data: zero paid batches while the kill switch is OFF
    expect(runSampleFn).not.toHaveBeenCalled();
    expect(onDisabled).toHaveBeenCalledWith(undefined);
  });

  // @invariant data: the retained batch keeps the injected runner and selected lane
  // @fails-if drop the dependencies or config; the paid call uses a different runner or lane
  it('enabled — runs the batch with the gate config and forwards sampleDeps', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const sampleDeps = { runTaskInner: async () => ({ text: 'ok' }) };
    const runSampleFn = vi.fn(async () => RESULT);
    const onSampled = vi.fn();
    const outcome = await runCalibrationSampleOperation(
      db,
      { kind: 'pg-boss', jobId: 'job-1' },
      { config: CFG, resolveProviderFn: () => {}, runSampleFn, sampleDeps },
      { onSampled },
    );
    expect(outcome).toEqual({
      kind: 'sampled',
      source: { kind: 'pg-boss', jobId: 'job-1' },
      result: RESULT,
    });
    expect(runSampleFn).toHaveBeenCalledWith(db, CFG, sampleDeps);
    expect(onSampled).toHaveBeenCalledWith(RESULT);
  });

  // @invariant data: failed paid work cannot be reported as a successful batch
  // @fails-if swallow the batch rejection; the operation resolves and reports success
  it('paid-batch failure — hook fires once, the error rethrows for the backend', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const failure = new Error('batch exploded');
    const runSampleFn = vi.fn(async () => {
      throw failure;
    });
    const onPaidBatchError = vi.fn();
    const onSampled = vi.fn();
    // @fails-if the operation swallows the batch error: the retry contract dies
    await expect(
      runCalibrationSampleOperation(
        db,
        { kind: 'pg-boss', jobId: 'job-1' },
        { config: CFG, resolveProviderFn: () => {}, runSampleFn },
        { onPaidBatchError, onSampled },
      ),
    ).rejects.toThrow('batch exploded');
    expect(onPaidBatchError).toHaveBeenCalledTimes(1);
    expect(onPaidBatchError).toHaveBeenCalledWith(failure);
    expect(onSampled).not.toHaveBeenCalled();
  });

  // @invariant data: failed second-lane preflight prevents paid batch execution
  // @fails-if catch preflight and continue; the batch executes on a failed lane
  it('pre-flight failure bypasses the paid-batch error hook (fail-loud face preserved)', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const onPaidBatchError = vi.fn();
    const runSampleFn = vi.fn();
    await expect(
      runCalibrationSampleOperation(
        db,
        { kind: 'pg-boss', jobId: 'job-1' },
        {
          config: CFG,
          resolveProviderFn: () => {
            throw new Error('unknown provider');
          },
          runSampleFn,
        },
        { onPaidBatchError },
      ),
    ).rejects.toThrow('unknown provider');
    // @invariant a dead lane is a gate failure, not a batch failure
    expect(onPaidBatchError).not.toHaveBeenCalled();
    expect(runSampleFn).not.toHaveBeenCalled();
  });

  // @invariant concurrency: a durable source keeps its cutoff clock and summary label
  // @fails-if forward wall clock instead of scheduledAt; repeat execution changes the label
  it('dbos source pins the batch clock to scheduledAt — even over a caller now()', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const scheduledAt = new Date('2026-10-11T22:10:00.000Z');
    const runSampleFn = vi.fn(
      async (
        _db: Db,
        _cfg: JudgeCalibrationConfig,
        _deps?: JudgeCalibrationSampleDeps,
      ): Promise<JudgeCalibrationSampleResult> => RESULT,
    );
    await runCalibrationSampleOperation(
      db,
      {
        kind: 'dbos',
        workflowId: 'sched-judge_calibration_sample-2026-10-11T22:10:00.000Z',
        scheduledAt,
      },
      {
        config: CFG,
        resolveProviderFn: () => {},
        runSampleFn,
        // Pin the cutoff clock and summary label. This does not freeze rows.
        sampleDeps: { now: () => new Date('2024-01-01T00:00:00.000Z') },
      },
    );
    const forwarded = runSampleFn.mock.calls[0]?.[2];
    // @invariant the dbos tick clock is the scheduled time, not wall clock
    expect(forwarded?.now?.().toISOString()).toBe(scheduledAt.toISOString());
  });

  // @invariant data: retained execution keeps the caller clock and runner dependencies
  // @fails-if rewrite pg-boss dependencies; the caller clock or runner is replaced
  it('pg-boss source forwards sampleDeps verbatim (no tick-time rewrite)', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const sampleDeps = { now: () => new Date('2024-01-01T00:00:00.000Z') };
    const runSampleFn = vi.fn(
      async (
        _db: Db,
        _cfg: JudgeCalibrationConfig,
        _deps?: JudgeCalibrationSampleDeps,
      ): Promise<JudgeCalibrationSampleResult> => RESULT,
    );
    await runCalibrationSampleOperation(
      db,
      { kind: 'pg-boss', jobId: 'job-1' },
      { config: CFG, resolveProviderFn: () => {}, runSampleFn, sampleDeps },
    );
    // Retained execution forwards the caller's dependency object unchanged.
    expect(runSampleFn.mock.calls[0]?.[2]).toBe(sampleDeps);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Part 2 — frozen workset identity + staged resume/apply seams (fix round).
// ═══════════════════════════════════════════════════════════════════════

const ANCHOR = new Date('2026-10-11T22:10:00.000Z');
const NEXT_NIGHT = new Date('2026-10-12T22:10:00.000Z');

const FROZEN_QUESTION: JudgeCalibrationRejudgeFace['question'] = {
  id: 'q_1',
  kind: 'short_answer',
  prompt_md: '两件同价商品总计84元，求单件价格并解释方程与单位。'.repeat(30),
  reference_md: '设单件价格为x元，则2x=84，因此x=42元。'.repeat(30),
  rubric_json: {
    criteria: [{ name: 'equation', weight: 1, descriptor: '两件总价与单件价格对应' }],
    required_points: ['2x=84', '42元'],
  },
  choices_md: null,
  judge_kind_override: null,
  knowledge_ids: ['k_math_1', 'k_math_2'],
  metadata: { source_context: { ambiguity: ['总价不是单价'], paragraphs: ['条件', '推导'] } },
};
const FROZEN_PROFILE = structuredClone(mathProfile);

const ITEM: CalibrationWorkSetItem = {
  judgeEventId: 'evt_judge_1',
  answerEventId: 'evt_answer_1',
  questionId: 'q_1',
  judgeRoute: 'judge.v2.open',
  priorOutcome: 'correct',
  answerMd: '一段足够长的历史作答文本，含嵌套结构与边界情况',
  studentImageRefs: [],
  question: FROZEN_QUESTION,
  subjectProfile: FROZEN_PROFILE,
  judgeCreatedAt: '2026-10-10T08:00:00.000Z',
};

function receiptFor(identity: CalibrationEffectIdentity): CalibrationItemReceipt {
  return { effect: identity, outcome: { coarse_outcome: 'correct', confidence: 0.87 } };
}

function stagedIds(
  anchor: Date,
  items: readonly CalibrationWorkSetItem[],
  item: CalibrationWorkSetItem | undefined = undefined,
  cfg: JudgeCalibrationConfig = CFG,
) {
  const member = item ?? items[0];
  if (!member) throw new Error('expected a frozen workset member');
  const workSetId = computeCalibrationWorkSetId({ anchor, cfg });
  const freezeDigest = computeCalibrationFreezeDigest(items);
  const identity = computeCalibrationEffectIdentity({ workSetId, freezeDigest, item: member, cfg });
  return {
    workSetId,
    freezeDigest,
    identity,
    effectId: computeCalibrationEffectId(identity),
    entityKey: computeCalibrationEntityKey(member.judgeEventId),
  };
}

const ITEM_B: CalibrationWorkSetItem = {
  ...ITEM,
  judgeEventId: 'evt_judge_2',
  answerEventId: 'evt_answer_2',
  questionId: 'q_2',
  question: { ...FROZEN_QUESTION, id: 'q_2' },
};

describe('frozen workset identity', () => {
  // @invariant concurrency: scheduler delivery identity never enters workset identity
  // @fails-if a delivery field (jobId/workflowId/scheduledAt) leaks into the workset id inputs
  it('workset id is delivery-agnostic — same anchor+cfg freeze the same workset', () => {
    const fromPgBossDelivery = computeCalibrationWorkSetId({ anchor: ANCHOR, cfg: CFG });
    const fromDbosDelivery = computeCalibrationWorkSetId({ anchor: ANCHOR, cfg: CFG });
    expect(fromDbosDelivery).toBe(fromPgBossDelivery);
    // @invariant concurrency: the next night's anchor is a different scheduling identity
    expect(computeCalibrationWorkSetId({ anchor: NEXT_NIGHT, cfg: CFG })).not.toBe(
      fromPgBossDelivery,
    );
    // @invariant data: a changed lane config is a different scheduling identity
    expect(
      computeCalibrationWorkSetId({ anchor: ANCHOR, cfg: { ...CFG, rejudgeModel: 'other' } }),
    ).not.toBe(fromPgBossDelivery);
  });

  // @invariant data: the freeze digest binds the FULL ordered workset
  // @fails-if hash unordered or item-blind; a swapped/re-frozen workset replays as the same freeze
  it('freeze digest binds the full workset — membership AND order', () => {
    const base = computeCalibrationFreezeDigest([ITEM, ITEM_B]);
    // @invariant data: the same items in the same order freeze identically
    expect(computeCalibrationFreezeDigest([ITEM, ITEM_B])).toBe(base);
    // @invariant data: selection order is part of the freeze
    expect(computeCalibrationFreezeDigest([ITEM_B, ITEM])).not.toBe(base);
    // @invariant data: a different item set is a different freeze
    expect(computeCalibrationFreezeDigest([ITEM])).not.toBe(base);
    expect(computeCalibrationFreezeDigest([ITEM_B])).not.toBe(base);
    expect(
      computeCalibrationFreezeDigest([{ ...ITEM, judgeEventId: 'replacement_judge' }]),
    ).not.toBe(computeCalibrationFreezeDigest([ITEM]));
  });

  // @invariant data: the input digest pins the frozen re-judge input face
  // @fails-if hash a mutable or delivery-dependent field; replay changes the digest
  it('input digest binds the FULL frozen face — question/profile edits are input changes', () => {
    const base = computeCalibrationInputDigest(ITEM);
    // @invariant data: canonical serialization — key order is not an input change
    expect(
      computeCalibrationInputDigest({
        ...ITEM,
        question: { metadata: FROZEN_QUESTION.metadata, ...FROZEN_QUESTION },
      }),
    ).toBe(base);
    // @invariant data: a changed judge route is a changed input face
    expect(computeCalibrationInputDigest({ ...ITEM, judgeRoute: 'judge.v3.math' })).not.toBe(base);
    // @invariant data: a changed answer text is a changed input face
    expect(computeCalibrationInputDigest({ ...ITEM, answerMd: '改写后的作答' })).not.toBe(base);
    // @invariant data: R1 P1b — a post-freeze question edit is a different input
    expect(
      computeCalibrationInputDigest({
        ...ITEM,
        question: { ...FROZEN_QUESTION, prompt_md: '编辑后的新题干' },
      }),
    ).not.toBe(base);
    // @invariant data: R1 P1b — a post-freeze subject-profile edit is a different input
    expect(
      computeCalibrationInputDigest({
        ...ITEM,
        subjectProfile: {
          ...FROZEN_PROFILE,
          promptFragments: { ...FROZEN_PROFILE.promptFragments, teachingStyle: '编辑后的学科指导' },
        },
      }),
    ).not.toBe(base);
  });

  // @invariant data: effect identity changes exactly when entity/revision/freeze/model/input change
  // @fails-if any coordinate change keeps the effect id; redelivered work is mistaken for new
  it('effect id changes when entity, revision, freeze, model or input change', () => {
    const base = stagedIds(ANCHOR, [ITEM, ITEM_B], ITEM);
    // @invariant concurrency: recomputing the same coordinates keeps the id
    expect(stagedIds(ANCHOR, [ITEM, ITEM_B], ITEM).effectId).toBe(base.effectId);
    const changed = [
      stagedIds(NEXT_NIGHT, [ITEM, ITEM_B], ITEM).identity, // scheduling revision
      stagedIds(ANCHOR, [ITEM], ITEM).identity, // a different frozen item SET changes the revision
      stagedIds(ANCHOR, [ITEM, ITEM_B], ITEM_B).identity, // a different entity
      stagedIds(ANCHOR, [ITEM, ITEM_B], ITEM, { ...CFG, rejudgeModel: 'other-model' }).identity, // model
      stagedIds(ANCHOR, [ITEM, ITEM_B], { ...ITEM, priorOutcome: 'partial' }).identity, // input face
    ];
    for (const identity of changed) {
      expect(computeCalibrationEffectId(identity)).not.toBe(base.effectId);
    }
  });

  // @invariant data: the resend blocker is revision-free
  // @fails-if entity key embeds the workset; later ticks stop seeing the obligation
  it('entity key is stable and revision-free', () => {
    expect(computeCalibrationEntityKey('evt_judge_1')).toBe(
      computeCalibrationEntityKey('evt_judge_1'),
    );
    expect(computeCalibrationEntityKey('evt_judge_1')).not.toBe(
      computeCalibrationEntityKey('evt_judge_2'),
    );
  });
});

describe('shared-store consumer gate', () => {
  // @invariant data: disabled sampling cannot admit an intent or execute a provider
  // @fails-if bypass the kill switch; the sentinel database lacks transaction and execution throws
  it('returns before the real store or execution seam when disabled', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: false });
    const executeItem = vi.fn(async (): Promise<never> => {
      throw new Error('must not spend');
    });
    expect(
      await runCalibrationStagedOperation(
        {},
        {
          database: db,
          dispatch: {
            version: 1,
            scheduledAt: ANCHOR.toISOString(),
            delivery: {
              backend: 'pg-boss',
              deliveryId: 'job-original',
              generation: 0,
              tickId: `sched-judge_calibration_sample-${ANCHOR.toISOString()}`,
            },
          },
          leaseExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
          workSet: { anchor: ANCHOR, items: [ITEM] },
          seams: {
            executeItem,
            applyReceipt: async () => {
              throw new Error('must not write');
            },
          },
        },
      ),
    ).toEqual({ kind: 'disabled', flagEnv: undefined });
    expect(executeItem).not.toHaveBeenCalled();
  });
});

describe('released core seams (real exports, no DB)', () => {
  async function loadCore() {
    return import('./judge-calibration-sample-core');
  }

  const executedAt = new Date('2026-10-11T22:14:23.000Z');
  const semanticText = JSON.stringify({
    score: 0.5,
    coarse_outcome: 'partial',
    confidence: 0.8,
    feedback_md: '方程正确，但需要说明单件单位。'.repeat(30),
    evidence_json: { matched_points: ['2x=84'], missing_points: ['单位'] },
  });

  // @invariant data: the real pipeline receives the prepared face and overrides its second lane
  // @fails-if reconstruct live rows or lose the pinned override; the captured judge/runner input changes
  it('executes the frozen question/profile/answer and captures the exact runner output', async () => {
    const core = await loadCore();
    const judgeFn = vi.fn(judgeAnswer);
    const runTaskInner = vi.fn<NonNullable<JudgeCalibrationSampleDeps['runTaskInner']>>(
      async () => ({ text: semanticText }),
    );
    const face = { ...ITEM, judgeRoute: 'semantic', studentImageRefs: [...ITEM.studentImageRefs] };
    const outcome = await core.judgeCalibrationPreparedFace(CFG, face, {
      db,
      judgeFn,
      runTaskInner,
    });
    expect(outcome).toMatchObject({
      kind: 'rejudged',
      coarseOutcome: 'partial',
      rawText: semanticText,
    });
    expect(judgeFn.mock.calls[0]?.[0]).toMatchObject({
      question: { ...ITEM.question, judge_kind_override: 'semantic' },
      answer_md: ITEM.answerMd,
      subjectProfile: ITEM.subjectProfile,
      student_image_refs: [],
    });
    expect(runTaskInner).toHaveBeenCalledOnce();
    expect(runTaskInner.mock.calls[0]).toEqual([
      'SemanticJudgeTask',
      expect.anything(),
      expect.objectContaining({
        override: { provider: CFG.rejudgeProvider, model: CFG.rejudgeModel },
      }),
    ]);
  });

  // @invariant data: preparation detaches question/answer/profile objects before later mutations
  // @fails-if freeze retains a live profile or execution re-reads a business row; the saved face changes or the send fails
  it('freezes through the real core then ignores mutable source edits and records the changed execution clock', async () => {
    const core = await loadCore();
    const questionRow = { ...structuredClone(FROZEN_QUESTION), knowledge_ids: [] };
    const answerPayload = { answer_md: ITEM.answerMd, answer_image_refs: ['asset_original'] };
    const sourceProfile = resolveSubjectProfile(null);
    const originalTeachingStyle = sourceProfile.promptFragments.teachingStyle;
    preparationRows.rows = [
      [{ id: ITEM.answerEventId, subject_id: ITEM.questionId, payload: answerPayload }],
      [questionRow],
    ];
    const frozen = await core.freezeCalibrationWorkSetFromCandidates(db, [
      {
        id: ITEM.judgeEventId,
        subject_id: ITEM.answerEventId,
        created_at: ANCHOR,
        payload: { judge_route: 'semantic', coarse_outcome: 'correct' },
      },
    ]);
    const item = frozen.items[0];
    if (!item) throw new Error('expected a prepared item');
    const initialDigest = computeCalibrationInputDigest(item);
    let clock = ANCHOR;
    const cfg = { ...CFG };
    const runTaskInner = vi.fn<NonNullable<JudgeCalibrationSampleDeps['runTaskInner']>>(
      async () => ({ text: semanticText }),
    );
    const seams = await buildCalibrationStagedCoreSeams(db, cfg, {
      runTaskInner,
      now: () => clock,
    });
    try {
      questionRow.prompt_md = 'later edited question';
      answerPayload.answer_md = 'later edited answer';
      answerPayload.answer_image_refs.push('later_asset');
      sourceProfile.promptFragments.teachingStyle = 'later edited subject profile';
      cfg.rejudgeModel = 'later-model';
      clock = executedAt;
      const identity = stagedIds(ANCHOR, [item]).identity;
      const sent = await seams.executeItem(item, identity, { anchor: ANCHOR });
      if (sent.kind !== 'sent') throw new Error('expected a receipt');
      expect(computeCalibrationInputDigest(item)).toBe(initialDigest);
      expect(sent.receipt.outcome).toMatchObject({
        config: CFG,
        executed_at: executedAt.toISOString(),
        prepared_input: {
          question: { prompt_md: FROZEN_QUESTION.prompt_md },
          answer_md: ITEM.answerMd,
          student_image_refs: ['asset_original'],
          subject_profile: { promptFragments: { teachingStyle: originalTeachingStyle } },
        },
      });
      expect(runTaskInner.mock.calls[0]?.[1]).toMatchObject({
        answer: { content: ITEM.answerMd },
        question: { prompt_md: FROZEN_QUESTION.prompt_md },
      });
      expect(preparationRows.rows).toEqual([]);
    } finally {
      sourceProfile.promptFragments.teachingStyle = originalTeachingStyle;
    }
  });

  // @invariant data: unsupported remains a classification with no observation
  // @fails-if classify unsupported as a disagreement; a rejudged outcome or write appears
  it('classifies unsupported without manufacturing a judged receipt', async () => {
    const core = await loadCore();
    const judgeFn: typeof judgeAnswer = async () => ({
      route: 'semantic',
      modelAttempted: false,
      result: unsupportedResult('semantic', '无法评分', { reason: 'invalid_rubric' }),
    });
    expect(
      await core.judgeCalibrationPreparedFace(
        CFG,
        { ...ITEM, studentImageRefs: [...ITEM.studentImageRefs] },
        { db, judgeFn, runTaskInner: async () => ({ text: semanticText }) },
      ),
    ).toEqual({ kind: 'unsupported' });
    expect(writeEvent).not.toHaveBeenCalled();
  });

  // @invariant concurrency: an unknown runner outcome cannot become a terminal unsupported discharge
  // @fails-if trust the pipeline's swallowed rejection; executeItem returns a skip instead of rejecting
  it('preserves a swallowed runner rejection for durable unknown classification', async () => {
    const item = { ...ITEM, judgeRoute: 'semantic' };
    const failure = new Error('wire response missing');
    const runTaskInner = vi.fn<NonNullable<JudgeCalibrationSampleDeps['runTaskInner']>>(
      async () => {
        throw failure;
      },
    );
    const seams = await buildCalibrationStagedCoreSeams(db, CFG, { runTaskInner });
    await expect(
      seams.executeItem(item, stagedIds(ANCHOR, [item]).identity, { anchor: ANCHOR }),
    ).rejects.toBe(failure);
    expect(runTaskInner).toHaveBeenCalledOnce();
    expect(writeEvent).not.toHaveBeenCalled();
  });

  async function sendReceipt() {
    setTestConfig({ VISION_JUDGE_PROVIDER: 'xiaomi', 'lane.global.provider': 'xiaomi' });
    const item = { ...ITEM, judgeRoute: 'semantic' };
    const cfg = { ...CFG };
    const runTaskInner = vi.fn<NonNullable<JudgeCalibrationSampleDeps['runTaskInner']>>(
      async () => {
        // Changes while the request is pending must not change its provenance.
        cfg.rejudgeModel = 'changed-during-call';
        setTestConfig({
          VISION_JUDGE_PROVIDER: 'anthropic-sub',
          'lane.global.provider': 'anthropic-sub',
        });
        return { text: semanticText };
      },
    );
    const seams = await buildCalibrationStagedCoreSeams(db, cfg, {
      runTaskInner,
      now: () => executedAt,
    });
    const identity = stagedIds(ANCHOR, [item]).identity;
    const execution = await seams.executeItem(item, identity, { anchor: ANCHOR });
    if (execution.kind !== 'sent') throw new Error('expected a real semantic receipt');
    return { item, identity, receipt: execution.receipt, runTaskInner };
  }

  // @invariant data: a later config/model/clock applies the saved receipt without another send
  // @fails-if rebuild provenance from the new tick or re-buy the entity while recovering it
  it('apply failure recovers on a later tick using the original input, lane, model and execution time', async () => {
    const { identity, receipt, runTaskInner } = await sendReceipt();
    const original = structuredClone(receipt);
    const first = await buildCalibrationStagedCoreSeams(db, CFG);
    vi.mocked(writeEvent).mockRejectedValueOnce(new Error('observation write failed'));
    await expect(first.applyReceipt(receipt, identity, { anchor: ANCHOR })).rejects.toThrow(
      'observation write failed',
    );
    const later = await buildCalibrationStagedCoreSeams(
      db,
      { ...CFG, rejudgeModel: 'later-model', windowDays: 30 },
      { now: () => NEXT_NIGHT },
    );
    expect(await later.applyReceipt(receipt, identity, { anchor: NEXT_NIGHT })).toMatchObject({
      write: 'written',
    });
    expect(runTaskInner).toHaveBeenCalledOnce();
    expect(receipt).toEqual(original);
    expect(vi.mocked(writeEvent).mock.calls[1]?.[1]).toMatchObject({
      action: 'experimental:judge_calibration_sample',
      created_at: executedAt,
      ingest_at: executedAt,
      payload: {
        sampled_at: executedAt.toISOString(),
        rejudge_provider: CFG.rejudgeProvider,
        rejudge_model: CFG.rejudgeModel,
        vision_judge_provider_at_sample: 'xiaomi',
        ai_provider_override_at_sample: 'xiaomi',
        same_lane_suspected: false,
      },
    });
  });

  // @invariant data: receipt mutation cannot be applied and the original payload remains available
  // @fails-if trust only the identity echo; altered question/config provenance reaches the writer
  it('rejects mutated input/config and missing provenance before any observation write', async () => {
    const { identity, receipt } = await sendReceipt();
    const seams = await buildCalibrationStagedCoreSeams(db, { ...CFG, rejudgeModel: 'later' });
    const changedInput = structuredClone(receipt);
    const input = changedInput.outcome.prepared_input;
    if (!input || typeof input !== 'object') throw new Error('missing prepared input');
    Reflect.set(input, 'answer_md', 'changed answer');
    const changedCfg = {
      ...receipt,
      outcome: { ...receipt.outcome, config: { ...CFG, rejudgeModel: 'wrong' } },
    };
    await expect(
      seams.applyReceipt(changedInput, identity, { anchor: NEXT_NIGHT }),
    ).rejects.toThrow('does not match effect');
    await expect(seams.applyReceipt(changedCfg, identity, { anchor: NEXT_NIGHT })).rejects.toThrow(
      'does not match effect',
    );
    await expect(
      seams.applyReceipt(receiptFor(identity), identity, { anchor: NEXT_NIGHT }),
    ).rejects.toThrow('send-time facts');
    expect(writeEvent).not.toHaveBeenCalled();
    expect(receipt.outcome).toMatchObject({ prepared_input: { answer_md: ITEM.answerMd } });
  });

  // @invariant data: a unique-index collision alone does not discharge an immutable receipt
  // @fails-if map the core unique conflict to written; the seam incorrectly claims application ownership
  it('reports the MF8 unique conflict without claiming application ownership', async () => {
    const { receipt, identity } = await sendReceipt();
    const seams = await buildCalibrationStagedCoreSeams(db, CFG);
    vi.mocked(writeEvent).mockRejectedValue({ code: '23505' });
    expect(await seams.applyReceipt(receipt, identity, { anchor: NEXT_NIGHT })).toEqual({
      domainRef: `experimental:judge_calibration_sample:${identity.judgeEventId}`,
      write: 'unique_duplicate',
    });
  });
});
