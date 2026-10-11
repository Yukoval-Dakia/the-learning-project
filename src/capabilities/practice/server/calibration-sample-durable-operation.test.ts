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
  readCalibrationSampleGate,
  runCalibrationSampleOperation,
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
