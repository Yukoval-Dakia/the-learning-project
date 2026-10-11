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
  type ApplyCalibrationReceiptFn,
  type CalibrationEffectIdentity,
  type CalibrationItemExecution,
  type CalibrationItemReceipt,
  type CalibrationStagedEffectRecord,
  type CalibrationStagedExecutionPort,
  type CalibrationStagedOperationOutcome,
  type CalibrationWorkSetItem,
  type ExecuteCalibrationItemFn,
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

const ITEM_B: CalibrationWorkSetItem = {
  judgeEventId: 'evt_judge_2',
  answerEventId: 'evt_answer_2',
  questionId: 'q_2',
  judgeRoute: 'judge.v2.open',
  priorOutcome: 'incorrect',
  answerMd: '另一份作答',
  studentImageRefs: [],
  question: { ...FROZEN_QUESTION, id: 'q_2', prompt_md: '另一道商品问题' },
  subjectProfile: FROZEN_PROFILE,
  judgeCreatedAt: '2026-10-10T09:30:00.000Z',
};

/** In-memory append-only double for the PROVISIONAL lane-B port. `loseReserve`
 * forces the next reserveIntent to lose against `winner` — the concurrent
 * double-process face; `loadOverride` simulates a stale empty snapshot. */
class MemoryStagedPort implements CalibrationStagedExecutionPort {
  readonly rows: CalibrationStagedEffectRecord[] = [];
  readonly appendedRows: CalibrationStagedEffectRecord[] = [];
  loseReserve: CalibrationStagedEffectRecord | null = null;
  loadOverride: readonly CalibrationStagedEffectRecord[] | null = null;

  async loadFamilyRecords(): Promise<CalibrationStagedEffectRecord[]> {
    return [...(this.loadOverride ?? this.rows)];
  }
  async reserveIntent(
    record: CalibrationStagedEffectRecord,
  ): Promise<{ status: 'reserved' } | { status: 'lost'; winner: CalibrationStagedEffectRecord }> {
    if (this.loseReserve !== null) {
      const winner = this.loseReserve;
      this.loseReserve = null;
      return { status: 'lost', winner };
    }
    this.rows.push(record);
    return { status: 'reserved' };
  }
  async appendRecord(record: CalibrationStagedEffectRecord): Promise<void> {
    this.rows.push(record);
    this.appendedRows.push(record);
  }
}

function receiptFor(identity: CalibrationEffectIdentity): CalibrationItemReceipt {
  return { effect: identity, outcome: { coarse_outcome: 'correct', confidence: 0.87 } };
}

const APPLY_OK: ApplyCalibrationReceiptFn = async (_receipt, identity) => ({
  domainRef: `experimental:judge_calibration_sample:${identity.judgeEventId}`,
  write: 'written',
});
function stagedIds(
  anchor: Date,
  items: readonly CalibrationWorkSetItem[],
  item: CalibrationWorkSetItem = items[0] as CalibrationWorkSetItem,
  cfg: JudgeCalibrationConfig = CFG,
) {
  const workSetId = computeCalibrationWorkSetId({ anchor, cfg });
  const freezeDigest = computeCalibrationFreezeDigest(items);
  const identity = computeCalibrationEffectIdentity({ workSetId, freezeDigest, item, cfg });
  return {
    workSetId,
    freezeDigest,
    identity,
    effectId: computeCalibrationEffectId(identity),
    entityKey: computeCalibrationEntityKey(item.judgeEventId),
  };
}

function completedRow(
  anchor: Date,
  items: readonly CalibrationWorkSetItem[],
  receipt: CalibrationItemReceipt,
): CalibrationStagedEffectRecord {
  const ids = stagedIds(anchor, items);
  return {
    effectId: ids.effectId,
    entityKey: ids.entityKey,
    identity: ids.identity,
    stage: 'completed',
    receipt,
    application: null,
    classification: null,
    recordedAt: anchor.toISOString(),
  };
}

const SENT_OK: ExecuteCalibrationItemFn = async (_item, identity) => ({
  kind: 'sent',
  receipt: receiptFor(identity),
});
async function runStaged(
  port: CalibrationStagedExecutionPort,
  executeItem: ExecuteCalibrationItemFn,
  workSet: { anchor: Date; items: readonly CalibrationWorkSetItem[] },
  applyReceipt: ApplyCalibrationReceiptFn = APPLY_OK,
): Promise<CalibrationStagedOperationOutcome> {
  return runCalibrationStagedOperation(
    { config: CFG, resolveProviderFn: () => {} },
    { workSet, port, executeItem, applyReceipt },
  );
}

function expectStagedReport(outcome: CalibrationStagedOperationOutcome) {
  expect(outcome.kind).toBe('staged');
  if (outcome.kind !== 'staged') throw new Error('unreachable: staged outcome expected');
  return outcome.report;
}

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

describe('runCalibrationStagedOperation', () => {
  // @invariant security: the staged path cannot spend or persist while the kill switch is OFF
  // @fails-if bypass the shared gate; the port is loaded or a send starts
  it('default OFF — disabled before any port load, reserve, append, send or apply', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: false });
    const port = new MemoryStagedPort();
    const loadSpy = vi.spyOn(port, 'loadFamilyRecords');
    const reserveSpy = vi.spyOn(port, 'reserveIntent');
    const appendSpy = vi.spyOn(port, 'appendRecord');
    const executeItem = vi.fn();
    const applyReceipt = vi.fn();
    const outcome = await runCalibrationStagedOperation(
      {},
      { workSet: { anchor: ANCHOR, items: [ITEM] }, port, executeItem, applyReceipt },
    );
    expect(outcome).toEqual({ kind: 'disabled', flagEnv: undefined });
    expect(loadSpy).not.toHaveBeenCalled();
    expect(reserveSpy).not.toHaveBeenCalled();
    expect(appendSpy).not.toHaveBeenCalled();
    expect(executeItem).not.toHaveBeenCalled();
    expect(applyReceipt).not.toHaveBeenCalled();
  });

  // @invariant concurrency: intent is reserved atomically BEFORE the send; apply before applied
  // @fails-if send before reserve or mark applied without the apply seam's evidence
  it('fresh item — reserve→send→receipt→apply; applied row carries application evidence', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const port = new MemoryStagedPort();
    const order: string[] = [];
    const executeItem = vi.fn(async (...args: Parameters<ExecuteCalibrationItemFn>) => {
      order.push('execute');
      return SENT_OK(...args);
    });
    const applyReceipt = vi.fn(async (...args: Parameters<ApplyCalibrationReceiptFn>) => {
      order.push('apply');
      return APPLY_OK(...args);
    });
    const report = expectStagedReport(
      await runStaged(port, executeItem, { anchor: ANCHOR, items: [ITEM] }, applyReceipt),
    );
    expect(report.dispositions[0]?.kind).toBe('applied_fresh');
    expect(report.counts.appliedFresh).toBe(1);
    expect(report.openObligations).toEqual([]);
    expect(report.pendingApplications).toEqual([]);
    expect(report.freezeMismatch).toBeNull();
    // intent row comes from the RESERVE (atomic), observations from appendRecord
    expect(port.rows.map((r) => r.stage)).toEqual(['intent', 'completed', 'applied']);
    expect(port.appendedRows.map((r) => r.stage)).toEqual(['completed', 'applied']);
    // @invariant concurrency: the physical send strictly follows the won reserve
    expect(order).toEqual(['execute', 'apply']);
    expect(executeItem).toHaveBeenCalledTimes(1);
    expect(applyReceipt).toHaveBeenCalledTimes(1);
    // @invariant concurrency: every record carries the frozen anchor, never a wall clock
    for (const row of port.rows) expect(row.recordedAt).toBe(ANCHOR.toISOString());
    // @invariant data: the persisted receipt is exact and echoes its effect identity
    const identity = stagedIds(ANCHOR, [ITEM]).identity;
    expect(port.rows[1]?.receipt).toEqual(receiptFor(identity));
    // @invariant data: applied is marked ONLY with the apply seam's trusted evidence
    expect(port.rows[2]?.application).toEqual({
      domainRef: `experimental:judge_calibration_sample:${ITEM.judgeEventId}`,
      write: 'written' as const,
    });
  });

  // @invariant concurrency: a lost atomic reserve never sends — even on a stale empty snapshot
  // @fails-if trust the loaded snapshot instead of the reserve verdict; both processes send
  it('lost reserve — no send and no append even when the loaded snapshot was empty', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const port = new MemoryStagedPort();
    const winnerRow: CalibrationStagedEffectRecord = {
      ...stagedIds(ANCHOR, [ITEM]),
      stage: 'intent',
      receipt: null,
      application: null,
      classification: null,
      recordedAt: ANCHOR.toISOString(),
    } as CalibrationStagedEffectRecord;
    // the f007 defect face: another process reserved after our (empty) load
    port.loadOverride = [];
    port.loseReserve = winnerRow;
    const executeItem = vi.fn();
    const applyReceipt = vi.fn();
    const report = expectStagedReport(
      await runStaged(port, executeItem, { anchor: ANCHOR, items: [ITEM] }, applyReceipt),
    );
    expect(report.dispositions[0]?.kind).toBe('reserved_by_other_process');
    expect(report.counts.reservedByOtherProcess).toBe(1);
    // @invariant concurrency: the loser sends nothing and appends nothing
    expect(executeItem).not.toHaveBeenCalled();
    expect(applyReceipt).not.toHaveBeenCalled();
    expect(port.appendedRows).toEqual([]);
    expect(port.rows).toEqual([]);
  });

  // @invariant data: an unknowable send outcome is a durable obligation, never auto-resent
  // @fails-if retry the send on replay; the provider is invoked twice
  it('send failure — durable unknown obligation, never resent on the same workset', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const port = new MemoryStagedPort();
    const executeItem = vi.fn(async () => {
      throw new Error('lane crashed mid-send');
    });
    const first = expectStagedReport(
      await runStaged(port, executeItem, { anchor: ANCHOR, items: [ITEM] }),
    );
    expect(first.dispositions[0]?.kind).toBe('held_unknown_send');
    expect(port.rows.map((r) => r.stage)).toEqual(['intent', 'sent_unknown']);
    const second = expectStagedReport(
      await runStaged(port, executeItem, { anchor: ANCHOR, items: [ITEM] }),
    );
    expect(second.dispositions[0]?.kind).toBe('held_unknown_send');
    // @invariant data: still exactly one physical send attempt across replays
    expect(executeItem).toHaveBeenCalledTimes(1);
    expect(port.rows.map((r) => r.stage)).toEqual(['intent', 'sent_unknown']);
    // @invariant data: the obligation appears in the report on every tick
    expect(second.openObligations).toEqual([
      {
        effectId: expect.any(String),
        entityKey: computeCalibrationEntityKey(ITEM.judgeEventId),
        judgeEventId: ITEM.judgeEventId,
        stage: 'sent_unknown',
        workSetId: first.workSetId,
      },
    ]);
  });

  // @invariant data: a later tick re-selecting the same entity is blocked by the open obligation
  // @fails-if a new revision silently resets the resend prohibition
  it('new tick re-selecting the same entity — blocked, old obligation still reported', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const port = new MemoryStagedPort();
    const failing = vi.fn(async () => {
      throw new Error('lane crashed mid-send');
    });
    const first = expectStagedReport(
      await runStaged(port, failing, { anchor: ANCHOR, items: [ITEM] }),
    );
    expect(first.dispositions[0]?.kind).toBe('held_unknown_send');
    const later = expectStagedReport(
      await runStaged(port, failing, { anchor: NEXT_NIGHT, items: [ITEM] }),
    );
    expect(later.dispositions[0]?.kind).toBe('held_blocked_by_open_obligation');
    expect(later.counts.heldBlockedByOpenObligation).toBe(1);
    // @invariant data: the new tick never sends for a blocked entity
    expect(failing).toHaveBeenCalledTimes(1);
    // @invariant data: no new rows — the historical obligation is unchanged
    expect(port.rows.map((r) => r.stage)).toEqual(['intent', 'sent_unknown']);
    // @invariant data: the reported obligation keeps its ORIGINAL revision
    expect(later.openObligations[0]?.workSetId).toBe(first.workSetId);
    expect(later.openObligations[0]?.stage).toBe('sent_unknown');
  });

  // @invariant data: replaying a completed receipt must not invoke the provider
  // @fails-if resume re-sends or skips the apply; the sentinel executor throws
  it('completed receipt replay — provider never invoked, applied through the apply seam', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const port = new MemoryStagedPort();
    port.rows.push(completedRow(ANCHOR, [ITEM], receiptFor(stagedIds(ANCHOR, [ITEM]).identity)));
    const executeItem = vi.fn(async () => {
      throw new Error('provider must not be invoked on receipt replay');
    });
    const applyReceipt = vi.fn(async (...args: Parameters<ApplyCalibrationReceiptFn>) =>
      APPLY_OK(...args),
    );
    const report = expectStagedReport(
      await runStaged(port, executeItem, { anchor: ANCHOR, items: [ITEM] }, applyReceipt),
    );
    expect(report.dispositions[0]?.kind).toBe('applied_from_receipt');
    expect(report.counts.appliedFromReceipt).toBe(1);
    expect(executeItem).not.toHaveBeenCalled();
    expect(applyReceipt).toHaveBeenCalledTimes(1);
    expect(port.rows.map((r) => r.stage)).toEqual(['completed', 'applied']);
    // @invariant data: the applied row reuses the immutable receipt and carries evidence
    expect(port.rows[1]?.receipt).toEqual(port.rows[0]?.receipt);
    expect(port.rows[1]?.application?.domainRef).toBe(
      `experimental:judge_calibration_sample:${ITEM.judgeEventId}`,
    );
    expect(report.openObligations).toEqual([]);
    expect(report.pendingApplications).toEqual([]);
  });

  // @invariant data: an apply failure keeps the record completed — recoverable, provider never re-invoked
  // @fails-if mark applied without domain evidence or resend the provider to "recover"
  it('apply failure — stays completed (apply pending), recovered later WITHOUT the provider', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const port = new MemoryStagedPort();
    const order: string[] = [];
    const executeItem = vi.fn(async (...args: Parameters<ExecuteCalibrationItemFn>) => {
      order.push('execute');
      return SENT_OK(...args);
    });
    const failingApply: ApplyCalibrationReceiptFn = async () => {
      order.push('apply-fail');
      throw new Error('observation write failed');
    };
    const first = expectStagedReport(
      await runStaged(port, executeItem, { anchor: ANCHOR, items: [ITEM] }, failingApply),
    );
    // @invariant data: no applied row exists — echo equality is NOT domain application
    expect(first.dispositions[0]?.kind).toBe('completed_apply_pending');
    expect(port.rows.map((r) => r.stage)).toEqual(['intent', 'completed']);
    expect(first.pendingApplications).toEqual([
      { effectId: expect.any(String), judgeEventId: ITEM.judgeEventId, workSetId: first.workSetId },
    ]);
    expect(first.openObligations).toEqual([]);
    // second tick: the APPLICATION is retried through the seam; the provider is not
    const second = expectStagedReport(
      await runStaged(port, executeItem, { anchor: ANCHOR, items: [ITEM] }, APPLY_OK),
    );
    expect(second.dispositions[0]?.kind).toBe('applied_from_receipt');
    expect(executeItem).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['execute', 'apply-fail']);
    expect(port.rows.map((r) => r.stage)).toEqual(['intent', 'completed', 'applied']);
  });

  // @invariant data: an already-applied effect is a pure replay — nothing appended, nothing sent
  // @fails-if append, reserve or send on replay; rows grow or the sentinel executor throws
  it('applied replay — nothing reserved, appended or re-sent', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const port = new MemoryStagedPort();
    port.rows.push({
      ...completedRow(ANCHOR, [ITEM], receiptFor(stagedIds(ANCHOR, [ITEM]).identity)),
      stage: 'applied',
      application: {
        domainRef: `experimental:judge_calibration_sample:${ITEM.judgeEventId}`,
        write: 'written' as const,
      },
    });
    const executeItem = vi.fn(async () => {
      throw new Error('provider must not be invoked on applied replay');
    });
    const report = expectStagedReport(
      await runStaged(port, executeItem, { anchor: ANCHOR, items: [ITEM] }),
    );
    expect(report.dispositions[0]?.kind).toBe('applied_replay');
    expect(report.counts.appliedReplay).toBe(1);
    expect(executeItem).not.toHaveBeenCalled();
    expect(port.appendedRows).toEqual([]);
    expect(port.rows).toHaveLength(1);
  });

  // @invariant data: a receipt that does not echo its effect identity is held, not reused
  // @fails-if reuse a mismatched receipt; a corrupt row silently discharges the effect
  it('receipt identity-echo mismatch — held, not reused, not resent, and blocking', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const port = new MemoryStagedPort();
    const truth = stagedIds(ANCHOR, [ITEM]);
    const echoedWrong = receiptFor({ ...truth.identity, inputDigest: '0'.repeat(64) });
    port.rows.push(completedRow(ANCHOR, [ITEM], echoedWrong));
    const executeItem = vi.fn(async () => {
      throw new Error('provider must not be invoked for a mismatched receipt');
    });
    const applyReceipt = vi.fn();
    const report = expectStagedReport(
      await runStaged(port, executeItem, { anchor: ANCHOR, items: [ITEM] }, applyReceipt),
    );
    expect(report.dispositions[0]?.kind).toBe('held_receipt_mismatch');
    expect(executeItem).not.toHaveBeenCalled();
    // @invariant data: echo mismatch does not authorize an apply attempt
    expect(applyReceipt).not.toHaveBeenCalled();
    expect(port.rows.map((r) => r.stage)).toEqual(['completed']);
    expect(report.openObligations[0]?.stage).toBe('receipt_mismatch');
    // @invariant data: the corrupt receipt blocks later attempts for its entity too
    const later = expectStagedReport(
      await runStaged(port, executeItem, { anchor: NEXT_NIGHT, items: [ITEM] }, applyReceipt),
    );
    expect(later.dispositions[0]?.kind).toBe('held_blocked_by_open_obligation');
    expect(executeItem).not.toHaveBeenCalled();
  });

  // @invariant data: a clean skip is terminal for the effect — no obligation, no apply, no block
  // @fails-if treat a skip as an unknown send; an eternal obligation appears for a skipped item
  it('clean skip — terminal stage, not an obligation, replay does not re-execute', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const port = new MemoryStagedPort();
    const executeItem = vi.fn(
      async (): Promise<CalibrationItemExecution> => ({
        kind: 'skipped',
        classification: 'missing_input',
      }),
    );
    const applyReceipt = vi.fn();
    const first = expectStagedReport(
      await runStaged(port, executeItem, { anchor: ANCHOR, items: [ITEM] }, applyReceipt),
    );
    expect(first.dispositions[0]).toMatchObject({
      kind: 'skipped',
      classification: 'missing_input',
    });
    expect(port.rows.map((r) => r.stage)).toEqual(['intent', 'skipped']);
    expect(port.rows[1]?.classification).toBe('missing_input');
    expect(first.openObligations).toEqual([]);
    expect(first.pendingApplications).toEqual([]);
    expect(applyReceipt).not.toHaveBeenCalled();
    const second = expectStagedReport(
      await runStaged(port, executeItem, { anchor: ANCHOR, items: [ITEM] }, applyReceipt),
    );
    expect(second.dispositions[0]).toMatchObject({
      kind: 'skipped',
      classification: 'missing_input',
    });
    // @invariant data: the skip is NOT re-executed on replay of the same workset
    expect(executeItem).toHaveBeenCalledTimes(1);
    // @invariant data: a later tick is NOT blocked by a terminal skip
    const later = expectStagedReport(
      await runStaged(port, executeItem, { anchor: NEXT_NIGHT, items: [ITEM] }, applyReceipt),
    );
    expect(later.dispositions[0]?.kind).not.toBe('held_blocked_by_open_obligation');
  });

  // @invariant data: history is append-only — later runs never rewrite earlier rows
  // @fails-if a later tick mutates or erases stored rows; the deep-equal snapshot fails
  it('append-only history — earlier rows survive byte-for-byte across later runs', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const port = new MemoryStagedPort();
    const executeItem = vi.fn(async (...args: Parameters<ExecuteCalibrationItemFn>) => {
      if (args[1].judgeEventId === ITEM_B.judgeEventId) {
        throw new Error('item B lane crash');
      }
      return SENT_OK(...args);
    });
    const first = expectStagedReport(
      await runStaged(port, executeItem, { anchor: ANCHOR, items: [ITEM, ITEM_B] }),
    );
    expect(first.counts.appliedFresh).toBe(1);
    expect(first.counts.heldUnknownSend).toBe(1);
    const snapshot = JSON.parse(JSON.stringify(port.rows)) as CalibrationStagedEffectRecord[];
    const second = expectStagedReport(
      await runStaged(port, executeItem, { anchor: ANCHOR, items: [ITEM, ITEM_B] }),
    );
    expect(second.counts.appliedReplay).toBe(1);
    expect(second.counts.heldUnknownSend).toBe(1);
    expect(port.rows).toHaveLength(snapshot.length);
    // @invariant data: byte-for-byte history preservation across replays
    expect(port.rows).toEqual(snapshot);
    const later = expectStagedReport(
      await runStaged(port, executeItem, { anchor: NEXT_NIGHT, items: [ITEM_B] }),
    );
    expect(later.counts.heldBlockedByOpenObligation).toBe(1);
    expect(port.rows).toEqual(snapshot);
    // @invariant data: the open obligation from the old revision keeps appearing
    expect(later.openObligations).toEqual([
      {
        effectId: expect.any(String),
        entityKey: computeCalibrationEntityKey(ITEM_B.judgeEventId),
        judgeEventId: ITEM_B.judgeEventId,
        stage: 'sent_unknown',
        workSetId: first.workSetId,
      },
    ]);
  });

  // @invariant data: applied history does not block a new revision — only open obligations block
  // @fails-if block on any historical row; the next night can never re-judge a completed entity
  it('applied history — a new revision may execute after completed history', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const port = new MemoryStagedPort();
    port.rows.push({
      ...completedRow(ANCHOR, [ITEM], receiptFor(stagedIds(ANCHOR, [ITEM]).identity)),
      stage: 'applied',
      application: {
        domainRef: `experimental:judge_calibration_sample:${ITEM.judgeEventId}`,
        write: 'written' as const,
      },
    });
    const before = JSON.parse(JSON.stringify(port.rows)) as CalibrationStagedEffectRecord[];
    const report = expectStagedReport(
      await runStaged(port, SENT_OK, { anchor: NEXT_NIGHT, items: [ITEM] }),
    );
    expect(report.dispositions[0]?.kind).toBe('applied_fresh');
    expect(report.counts.appliedFresh).toBe(1);
    // @invariant data: the new revision is a NEW effect — history stays intact before it
    expect(port.rows.slice(0, 1)).toEqual(before);
    expect(port.rows).toHaveLength(4);
    for (const row of port.rows.slice(1)) {
      expect(row.recordedAt).toBe(NEXT_NIGHT.toISOString());
      expect(row.identity.workSetId).toBe(report.workSetId);
      expect(row.identity.workSetId).not.toBe(before[0]?.identity.workSetId);
    }
  });

  // @invariant data: one physical send per entity per workset even with duplicate members
  // @fails-if process duplicates independently; the second duplicate sends again
  it('duplicate entity inside one workset — second occurrence held, single send', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const port = new MemoryStagedPort();
    const executeItem = vi.fn(async (...args: Parameters<ExecuteCalibrationItemFn>) =>
      SENT_OK(...args),
    );
    const report = expectStagedReport(
      await runStaged(port, executeItem, {
        anchor: ANCHOR,
        items: [ITEM, { ...ITEM, answerMd: '重复条目的不同作答' }],
      }),
    );
    expect(report.dispositions.map((d) => d.kind)).toEqual([
      'applied_fresh',
      'held_duplicate_in_workset',
    ]);
    expect(executeItem).toHaveBeenCalledTimes(1);
    expect(port.rows.map((r) => r.stage)).toEqual(['intent', 'completed', 'applied']);
  });

  // @invariant data: a workset id replayed with a different freeze is rejected whole
  // @fails-if accept a divergent item set under the same scheduling identity
  it('freeze mismatch — same workset id with a different frozen set is rejected whole', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const port = new MemoryStagedPort();
    const first = expectStagedReport(
      await runStaged(port, SENT_OK, { anchor: ANCHOR, items: [ITEM] }),
    );
    expect(first.freezeMismatch).toBeNull();
    const snapshot = JSON.parse(JSON.stringify(port.rows)) as CalibrationStagedEffectRecord[];
    const appendedAfterFirst = [...port.appendedRows];
    // SAME anchor+cfg (same workSetId), but a different frozen item set
    const divergent = expectStagedReport(
      await runStaged(port, SENT_OK, { anchor: ANCHOR, items: [ITEM_B] }),
    );
    expect(divergent.dispositions[0]?.kind).toBe('held_workset_freeze_mismatch');
    expect(divergent.counts.heldWorksetFreezeMismatch).toBe(1);
    expect(divergent.freezeMismatch).toEqual({
      workSetId: first.workSetId,
      presentedFreezeDigest: computeCalibrationFreezeDigest([ITEM_B]),
      recordedFreezeDigests: [computeCalibrationFreezeDigest([ITEM])],
    });
    // @invariant data: rejection means NO reserve, NO send, NO apply, NO append
    expect(port.rows).toEqual(snapshot);
    expect(port.appendedRows).toEqual(appendedAfterFirst);
    // @invariant data: the accepted freeze still replays cleanly afterwards
    const replay = expectStagedReport(
      await runStaged(port, SENT_OK, { anchor: ANCHOR, items: [ITEM] }),
    );
    expect(replay.dispositions[0]?.kind).toBe('applied_replay');
    expect(replay.freezeMismatch).toBeNull();
  });

  // @invariant data: a completed-pending-apply receipt must not be re-bought under a new revision
  // @fails-if only intent/sent_unknown block; a new tick re-sends while the receipt sits unapplied
  it('completed pending apply — a new revision is blocked until the receipt is applied', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const port = new MemoryStagedPort();
    const executeItem = vi.fn(async (...args: Parameters<ExecuteCalibrationItemFn>) =>
      SENT_OK(...args),
    );
    const failingApply: ApplyCalibrationReceiptFn = async () => {
      throw new Error('observation write still failing');
    };
    const first = expectStagedReport(
      await runStaged(port, executeItem, { anchor: ANCHOR, items: [ITEM] }, failingApply),
    );
    expect(first.dispositions[0]?.kind).toBe('completed_apply_pending');
    // a LATER tick, with the receipt STILL unapplied, must not re-buy the entity
    const later = expectStagedReport(
      await runStaged(port, executeItem, { anchor: NEXT_NIGHT, items: [ITEM] }, failingApply),
    );
    expect(later.dispositions[0]?.kind).toBe('held_blocked_by_open_obligation');
    expect(later.counts.heldBlockedByOpenObligation).toBe(1);
    expect(executeItem).toHaveBeenCalledTimes(1);
    // @invariant data: the pending application stays visible on every tick
    expect(later.pendingApplications).toEqual([
      { effectId: expect.any(String), judgeEventId: ITEM.judgeEventId, workSetId: first.workSetId },
    ]);
  });

  // @invariant data: a fresh receipt that fails the echo check is preserved as evidence
  // @fails-if discard the mismatching receipt; adjudication loses the original payload
  it('fresh echo mismatch — the original receipt is preserved on the sent_unknown row', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const port = new MemoryStagedPort();
    const mismatchingReceipt: CalibrationItemReceipt = {
      effect: { ...stagedIds(ANCHOR, [ITEM]).identity, inputDigest: 'f'.repeat(64) },
      outcome: { coarse_outcome: 'partial', confidence: 0.5 },
    };
    const executeItem = vi.fn(async () => ({ kind: 'sent' as const, receipt: mismatchingReceipt }));
    const applyReceipt = vi.fn();
    const report = expectStagedReport(
      await runStaged(port, executeItem, { anchor: ANCHOR, items: [ITEM] }, applyReceipt),
    );
    expect(report.dispositions[0]?.kind).toBe('held_unknown_send');
    expect(port.rows.map((r) => r.stage)).toEqual(['intent', 'sent_unknown']);
    // @invariant data: the mismatching receipt itself is kept for adjudication
    expect(port.rows[1]?.receipt).toEqual(mismatchingReceipt);
    expect(applyReceipt).not.toHaveBeenCalled();
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
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const { item, identity, receipt, runTaskInner } = await sendReceipt();
    const originalPayload = structuredClone(receipt);
    const port = new MemoryStagedPort();
    const firstSeams = await buildCalibrationStagedCoreSeams(db, CFG);
    vi.mocked(writeEvent).mockRejectedValueOnce(new Error('observation write failed'));
    const executeItem = vi.fn(async () => ({ kind: 'sent' as const, receipt }));
    const first = expectStagedReport(
      await runStaged(
        port,
        executeItem,
        { anchor: ANCHOR, items: [item] },
        firstSeams.applyReceipt,
      ),
    );
    expect(first.pendingApplications).toHaveLength(1);
    expect(port.rows.map((r) => r.stage)).toEqual(['intent', 'completed']);

    const laterCfg = { ...CFG, rejudgeModel: 'later-model', windowDays: 30 };
    const laterSeams = await buildCalibrationStagedCoreSeams(db, laterCfg, {
      now: () => NEXT_NIGHT,
    });
    const laterSend = vi.fn(laterSeams.executeItem);
    const later = expectStagedReport(
      await runCalibrationStagedOperation(
        { config: laterCfg, resolveProviderFn: () => {} },
        {
          port,
          workSet: { anchor: NEXT_NIGHT, items: [item] },
          executeItem: laterSend,
          applyReceipt: laterSeams.applyReceipt,
        },
      ),
    );
    expect(later.dispositions).toEqual([
      {
        judgeEventId: item.judgeEventId,
        effectId: computeCalibrationEffectId(identity),
        kind: 'applied_from_receipt',
        classification: undefined,
      },
    ]);
    expect(later.pendingApplications).toEqual([]);
    expect(laterSend).not.toHaveBeenCalled();
    expect(runTaskInner).toHaveBeenCalledOnce();
    expect(port.rows.map((r) => r.stage)).toEqual(['intent', 'completed', 'applied']);
    expect(port.rows[2]?.recordedAt).toBe(ANCHOR.toISOString());
    expect(port.rows[2]?.receipt).toEqual(originalPayload);
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
    expect(receipt.outcome).toMatchObject({
      config: CFG,
      executed_at: executedAt.toISOString(),
      prepared_input: {
        question: item.question,
        subject_profile: item.subjectProfile,
        answer_md: item.answerMd,
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
  // @fails-if label duplicate as a matching application; the record incorrectly becomes applied
  it('keeps a unique-conflict receipt pending without claiming immutable equality', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const { item, receipt, identity } = await sendReceipt();
    const seams = await buildCalibrationStagedCoreSeams(db, CFG);
    vi.mocked(writeEvent).mockRejectedValue({ code: '23505' });
    const port = new MemoryStagedPort();
    port.rows.push(completedRow(ANCHOR, [item], receipt));
    const executeItem = vi.fn(seams.executeItem);
    const report = expectStagedReport(
      await runStaged(port, executeItem, { anchor: ANCHOR, items: [item] }, seams.applyReceipt),
    );
    expect(report.pendingApplications).toHaveLength(1);
    expect(port.rows.map((r) => r.stage)).toEqual(['completed']);
    expect(executeItem).not.toHaveBeenCalled();
    await expect(
      seams.applyReceipt(receipt, identity, { anchor: NEXT_NIGHT }),
    ).resolves.toMatchObject({ write: 'unique_duplicate' });
  });
});
