// YUK-1355 — calibration-sample durable operation boundary, unit tests.
// The extracted operation must preserve the retained handler's contract
// verbatim: default-OFF gate, bare fail-loud pre-flight outside the batch
// error hook, lazy core seam, backend-visible failure rethrow, and the
// dbos-source fixed tick clock.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetTestConfig, setTestConfig } from '@/core/config/store';
import { type Db, db } from '@/db/client';
import { JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV } from '../jobs/judge-calibration-config';
import {
  type CalibrationEffectIdentity,
  type CalibrationItemReceipt,
  type CalibrationStagedEffectRecord,
  type CalibrationStagedExecutionPort,
  type CalibrationStagedOperationOutcome,
  type CalibrationWorkSetItem,
  type ExecuteCalibrationItemFn,
  computeCalibrationEffectId,
  computeCalibrationEffectIdentity,
  computeCalibrationEntityKey,
  computeCalibrationInputDigest,
  computeCalibrationWorkSetId,
  readCalibrationSampleGate,
  runCalibrationSampleOperation,
  runCalibrationStagedOperation,
} from './calibration-sample-durable-operation';
import type {
  JudgeCalibrationConfig,
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

vi.mock('@/db/client', () => ({ db: {} }));

beforeEach(() => {
  vi.unstubAllEnvs();
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
// Part 2 — frozen workset identity + staged resume/apply seams.
// ═══════════════════════════════════════════════════════════════════════

const ANCHOR = new Date('2026-10-11T22:10:00.000Z');
const NEXT_NIGHT = new Date('2026-10-12T22:10:00.000Z');

const ANSWER_PAYLOAD = {
  answer_md: '一段足够长的历史作答文本，含嵌套结构与边界情况',
  answer_image_refs: [] as string[],
};

const ITEM: CalibrationWorkSetItem = {
  judgeEventId: 'evt_judge_1',
  answerEventId: 'evt_answer_1',
  questionId: 'q_1',
  judgeRoute: 'judge.v2.open',
  priorOutcome: 'correct',
  judgePayload: { coarse_outcome: 'correct', judge_route: 'judge.v2.open' },
  answerPayload: ANSWER_PAYLOAD,
};

const ITEM_B: CalibrationWorkSetItem = {
  judgeEventId: 'evt_judge_2',
  answerEventId: 'evt_answer_2',
  questionId: 'q_2',
  judgeRoute: 'judge.v2.open',
  priorOutcome: 'incorrect',
  judgePayload: { coarse_outcome: 'incorrect', judge_route: 'judge.v2.open' },
  answerPayload: { answer_md: '另一份作答', answer_image_refs: [] as string[] },
};

/** In-memory append-only double for the PROVISIONAL lane-B port. */
class MemoryStagedPort implements CalibrationStagedExecutionPort {
  readonly rows: CalibrationStagedEffectRecord[] = [];
  async loadFamilyRecords(): Promise<CalibrationStagedEffectRecord[]> {
    return [...this.rows];
  }
  async appendRecord(record: CalibrationStagedEffectRecord): Promise<void> {
    this.rows.push(record);
  }
}

function receiptFor(identity: CalibrationEffectIdentity): CalibrationItemReceipt {
  return { effect: identity, outcome: { coarse_outcome: 'correct', confidence: 0.87 } };
}

function stagedIds(
  anchor: Date,
  item: CalibrationWorkSetItem = ITEM,
  cfg: JudgeCalibrationConfig = CFG,
) {
  const workSetId = computeCalibrationWorkSetId({ anchor, cfg });
  const identity = computeCalibrationEffectIdentity({ workSetId, item, cfg });
  return {
    workSetId,
    identity,
    effectId: computeCalibrationEffectId(identity),
    entityKey: computeCalibrationEntityKey(item.judgeEventId),
  };
}

function seedRow(port: MemoryStagedPort, row: CalibrationStagedEffectRecord): void {
  port.rows.push(row);
}

function completedRow(
  anchor: Date,
  receipt: CalibrationItemReceipt,
): CalibrationStagedEffectRecord {
  const ids = stagedIds(anchor);
  return {
    effectId: ids.effectId,
    entityKey: ids.entityKey,
    identity: ids.identity,
    stage: 'completed',
    receipt,
    recordedAt: anchor.toISOString(),
  };
}

async function runStaged(
  port: CalibrationStagedExecutionPort,
  executeItem: ExecuteCalibrationItemFn,
  workSet: { anchor: Date; items: readonly CalibrationWorkSetItem[] },
): Promise<CalibrationStagedOperationOutcome> {
  return runCalibrationStagedOperation(
    { config: CFG, resolveProviderFn: () => {} },
    { workSet, port, executeItem },
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
    // The same tick delivered once by pg-boss and once by DBOS shares anchor+cfg.
    const fromPgBossDelivery = computeCalibrationWorkSetId({ anchor: ANCHOR, cfg: CFG });
    const fromDbosDelivery = computeCalibrationWorkSetId({ anchor: ANCHOR, cfg: CFG });
    expect(fromDbosDelivery).toBe(fromPgBossDelivery);
    // @invariant concurrency: the next night's anchor is a different revision
    expect(computeCalibrationWorkSetId({ anchor: NEXT_NIGHT, cfg: CFG })).not.toBe(
      fromPgBossDelivery,
    );
    // @invariant data: a changed lane config is a different workset revision
    expect(
      computeCalibrationWorkSetId({ anchor: ANCHOR, cfg: { ...CFG, rejudgeModel: 'other' } }),
    ).not.toBe(fromPgBossDelivery);
  });

  // @invariant data: the input digest pins the frozen re-judge input face
  // @fails-if hash a mutable or delivery-dependent field; replay changes the digest
  it('input digest is payload-sensitive and key-order insensitive', () => {
    const base = computeCalibrationInputDigest(ITEM);
    // @invariant data: canonical serialization — key order is not an input change
    expect(
      computeCalibrationInputDigest({
        ...ITEM,
        answerPayload: { answer_image_refs: [], answer_md: ANSWER_PAYLOAD.answer_md },
      }),
    ).toBe(base);
    // @invariant data: a changed judge route is a changed input face
    expect(computeCalibrationInputDigest({ ...ITEM, judgeRoute: 'judge.v3.math' })).not.toBe(base);
    // @invariant data: a changed answer payload is a changed input face
    expect(
      computeCalibrationInputDigest({ ...ITEM, answerPayload: { answer_md: '改写后的作答' } }),
    ).not.toBe(base);
  });

  // @invariant data: effect identity changes exactly when entity/revision/model/input change
  // @fails-if any coordinate change keeps the effect id; redelivered work is mistaken for new
  it('effect id changes exactly when entity/revision/model/input change', () => {
    const base = stagedIds(ANCHOR);
    // @invariant concurrency: recomputing the same coordinates keeps the id
    expect(stagedIds(ANCHOR).effectId).toBe(base.effectId);
    const changed = [
      stagedIds(NEXT_NIGHT).identity, // revision
      stagedIds(ANCHOR, { ...ITEM, judgeEventId: 'evt_judge_other' }).identity, // entity
      stagedIds(ANCHOR, ITEM, { ...CFG, rejudgeModel: 'other-model' }).identity, // model
      stagedIds(ANCHOR, { ...ITEM, priorOutcome: 'partial' }).identity, // input face
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
  // @invariant data: the staged path cannot spend or persist while the kill switch is OFF
  // @fails-if bypass the shared gate; the port is loaded or a send starts
  it('default OFF — disabled before any port load, append or send', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: false });
    const port = new MemoryStagedPort();
    const loadSpy = vi.spyOn(port, 'loadFamilyRecords');
    const appendSpy = vi.spyOn(port, 'appendRecord');
    const executeItem = vi.fn();
    const outcome = await runCalibrationStagedOperation(
      {},
      { workSet: { anchor: ANCHOR, items: [ITEM] }, port, executeItem },
    );
    expect(outcome).toEqual({ kind: 'disabled', flagEnv: undefined });
    expect(loadSpy).not.toHaveBeenCalled();
    expect(appendSpy).not.toHaveBeenCalled();
    expect(executeItem).not.toHaveBeenCalled();
  });

  // @invariant data: intent persists before the physical send, then exact receipt, then apply
  // @fails-if send first; a crash leaves no obligation row
  it('fresh item — intent BEFORE the send, exact receipt, then applied; anchor is the only clock', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const port = new MemoryStagedPort();
    const executeItem = vi.fn(
      async (_item: CalibrationWorkSetItem, identity: CalibrationEffectIdentity) =>
        receiptFor(identity),
    );
    const report = expectStagedReport(
      await runStaged(port, executeItem, { anchor: ANCHOR, items: [ITEM] }),
    );
    expect(report.dispositions).toEqual([
      { judgeEventId: ITEM.judgeEventId, effectId: expect.any(String), kind: 'applied_fresh' },
    ]);
    expect(report.counts.appliedFresh).toBe(1);
    expect(report.openObligations).toEqual([]);
    expect(port.rows.map((r) => r.stage)).toEqual(['intent', 'completed', 'applied']);
    // @invariant concurrency: every record carries the frozen anchor, never a wall clock
    for (const row of port.rows) expect(row.recordedAt).toBe(ANCHOR.toISOString());
    // @invariant data: the persisted receipt is exact and echoes its effect identity
    const identity = computeCalibrationEffectIdentity({
      workSetId: report.workSetId,
      item: ITEM,
      cfg: CFG,
    });
    expect(port.rows[1]?.receipt).toEqual(receiptFor(identity));
    expect(executeItem).toHaveBeenCalledTimes(1);
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
  // @fails-if resume re-sends or infers nothing from the receipt; the sentinel executor throws
  it('completed receipt replay — provider never invoked, applied from the immutable receipt', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const port = new MemoryStagedPort();
    const seeded = completedRow(ANCHOR, receiptFor(stagedIds(ANCHOR).identity));
    seedRow(port, seeded);
    const executeItem = vi.fn(async () => {
      throw new Error('provider must not be invoked on receipt replay');
    });
    const report = expectStagedReport(
      await runStaged(port, executeItem, { anchor: ANCHOR, items: [ITEM] }),
    );
    expect(report.dispositions[0]?.kind).toBe('applied_from_receipt');
    expect(report.counts.appliedFromReceipt).toBe(1);
    expect(executeItem).not.toHaveBeenCalled();
    expect(port.rows.map((r) => r.stage)).toEqual(['completed', 'applied']);
    // @invariant data: the applied row reuses the immutable receipt unchanged
    expect(port.rows[1]?.receipt).toEqual(seeded.receipt);
    expect(report.openObligations).toEqual([]);
  });

  // @invariant data: an already-applied effect is a pure replay — nothing appended, nothing sent
  // @fails-if append or send on replay; rows grow or the sentinel executor throws
  it('applied replay — nothing appended, nothing re-sent', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const port = new MemoryStagedPort();
    seedRow(port, {
      ...completedRow(ANCHOR, receiptFor(stagedIds(ANCHOR).identity)),
      stage: 'applied',
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
    expect(port.rows).toHaveLength(1);
    expect(report.openObligations).toEqual([]);
  });

  // @invariant data: a receipt that does not echo its effect identity is held, not reused
  // @fails-if reuse a mismatched receipt; a corrupt row silently discharges the effect
  it('receipt identity-echo mismatch — held, not reused, not resent, and blocking', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const port = new MemoryStagedPort();
    const truth = stagedIds(ANCHOR);
    const echoedWrong = receiptFor({ ...truth.identity, inputDigest: '0'.repeat(64) });
    seedRow(port, completedRow(ANCHOR, echoedWrong));
    const executeItem = vi.fn(async () => {
      throw new Error('provider must not be invoked for a mismatched receipt');
    });
    const report = expectStagedReport(
      await runStaged(port, executeItem, { anchor: ANCHOR, items: [ITEM] }),
    );
    expect(report.dispositions[0]?.kind).toBe('held_receipt_mismatch');
    expect(executeItem).not.toHaveBeenCalled();
    expect(port.rows.map((r) => r.stage)).toEqual(['completed']);
    expect(report.openObligations[0]?.stage).toBe('receipt_mismatch');
    // @invariant data: the corrupt receipt blocks later attempts for its entity too
    const later = expectStagedReport(
      await runStaged(port, executeItem, { anchor: NEXT_NIGHT, items: [ITEM] }),
    );
    expect(later.dispositions[0]?.kind).toBe('held_blocked_by_open_obligation');
    expect(executeItem).not.toHaveBeenCalled();
  });

  // @invariant data: history is append-only — later runs never rewrite earlier rows
  // @fails-if a later tick mutates or erases stored rows; the deep-equal snapshot fails
  it('append-only history — earlier rows survive byte-for-byte across later runs', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const port = new MemoryStagedPort();
    const executeItem = vi.fn(
      async (_item: CalibrationWorkSetItem, identity: CalibrationEffectIdentity) => {
        if (identity.judgeEventId === ITEM_B.judgeEventId) {
          throw new Error('item B lane crash');
        }
        return receiptFor(identity);
      },
    );
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

  // @invariant data: completed history does not block a new revision — only open obligations block
  // @fails-if block on any historical row; the next night can never re-judge a completed entity
  it('applied history — a new revision may execute after completed history', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const port = new MemoryStagedPort();
    seedRow(port, {
      ...completedRow(ANCHOR, receiptFor(stagedIds(ANCHOR).identity)),
      stage: 'applied',
    });
    const before = JSON.parse(JSON.stringify(port.rows)) as CalibrationStagedEffectRecord[];
    const executeItem = vi.fn(
      async (_item: CalibrationWorkSetItem, identity: CalibrationEffectIdentity) =>
        receiptFor(identity),
    );
    const report = expectStagedReport(
      await runStaged(port, executeItem, { anchor: NEXT_NIGHT, items: [ITEM] }),
    );
    expect(report.dispositions[0]?.kind).toBe('applied_fresh');
    expect(report.counts.appliedFresh).toBe(1);
    // @invariant data: the new revision is a NEW effect — history stays intact before it
    expect(port.rows.slice(0, 1)).toEqual(before);
    expect(port.rows).toHaveLength(4);
    // @invariant data: the new rows carry the new workset's frozen anchor
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
    const executeItem = vi.fn(
      async (_item: CalibrationWorkSetItem, identity: CalibrationEffectIdentity) =>
        receiptFor(identity),
    );
    const report = expectStagedReport(
      await runStaged(port, executeItem, {
        anchor: ANCHOR,
        items: [ITEM, { ...ITEM, answerPayload: { answer_md: '重复条目的不同载荷' } }],
      }),
    );
    expect(report.dispositions.map((d) => d.kind)).toEqual([
      'applied_fresh',
      'held_duplicate_in_workset',
    ]);
    expect(executeItem).toHaveBeenCalledTimes(1);
    expect(port.rows.map((r) => r.stage)).toEqual(['intent', 'completed', 'applied']);
  });
});
