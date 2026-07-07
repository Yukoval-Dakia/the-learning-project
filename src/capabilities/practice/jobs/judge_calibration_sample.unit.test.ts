// YUK-573 — judge_calibration_sample handler guards (unit, no DB):
//   1. kill switch: strict '1' opt-in (YUK-572 RESEARCH_MEETING_AGENT_ENABLED
//      pattern) — default OFF, cron registered but handler no-ops.
//   2. MF3① batch pre-flight: resolveTaskProvider runs OUTSIDE the judge
//      routes' try/catch swallow — a missing CLAUDE_CODE_OAUTH_TOKEN makes the
//      WHOLE handler throw (pg-boss-visible failure), never a silent night of
//      unsupported skips. Deliberate reverse of vision-judge-config's
//      degrade-to-undefined.
//   3. core failure rethrows (pg-boss retry; MF8 unique index guards replays).
//   4. env config reader defaults + clamps.
import type { Db } from '@/db/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  JUDGE_CALIBRATION_DEFAULTS,
  JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV,
  readJudgeCalibrationConfig,
} from './judge-calibration-config';
import { buildJudgeCalibrationSampleHandler } from './judge_calibration_sample';

const mockDb = {} as Db;

function okResult() {
  return { sampled: 0, agreed: 0, disagreed: 0, skipped: 0, skipped_unsupported: 0, errors: 0 };
}

describe('buildJudgeCalibrationSampleHandler', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('kill switch: env unset → no-op (no pre-flight, no sampling)', async () => {
    vi.stubEnv(JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV, '');
    const runSampleFn = vi.fn(async () => okResult());
    const resolveProviderFn = vi.fn();
    const handler = buildJudgeCalibrationSampleHandler(mockDb, {
      runSampleFn,
      resolveProviderFn,
    });
    await handler([]);
    expect(resolveProviderFn).not.toHaveBeenCalled();
    expect(runSampleFn).not.toHaveBeenCalled();
  });

  it("kill switch: env 'true' (not strictly '1') → still no-op", async () => {
    vi.stubEnv(JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV, 'true');
    const runSampleFn = vi.fn(async () => okResult());
    const handler = buildJudgeCalibrationSampleHandler(mockDb, { runSampleFn });
    await handler([]);
    expect(runSampleFn).not.toHaveBeenCalled();
  });

  it("env '1' → pre-flight then sampling with the resolved config", async () => {
    vi.stubEnv(JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV, '1');
    const runSampleFn = vi.fn(async () => okResult());
    const resolveProviderFn = vi.fn();
    const handler = buildJudgeCalibrationSampleHandler(mockDb, {
      runSampleFn,
      resolveProviderFn,
    });
    await handler([]);
    expect(resolveProviderFn).toHaveBeenCalledWith('SemanticJudgeTask', {
      provider: 'anthropic-sub',
      model: 'claude-opus-4-8',
    });
    expect(runSampleFn).toHaveBeenCalledTimes(1);
    expect(runSampleFn.mock.calls[0]?.[0]).toBe(mockDb);
    expect(runSampleFn.mock.calls[0]?.[1]).toMatchObject({
      rejudgeProvider: 'anthropic-sub',
      batchMax: 20,
    });
  });

  it('MF3① pre-flight: missing CLAUDE_CODE_OAUTH_TOKEN → handler throws, zero sampling', async () => {
    vi.stubEnv(JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV, '1');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    // REAL resolveTaskProvider: anthropic-sub without a token must throw loudly.
    const runSampleFn = vi.fn(async () => okResult());
    const handler = buildJudgeCalibrationSampleHandler(mockDb, { runSampleFn });
    await expect(handler([])).rejects.toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(runSampleFn).not.toHaveBeenCalled();
  });

  it('pre-flight passes with a token present (real resolver, oauth lane)', async () => {
    vi.stubEnv(JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV, '1');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'test-token-never-logged');
    const runSampleFn = vi.fn(async () => okResult());
    const handler = buildJudgeCalibrationSampleHandler(mockDb, { runSampleFn });
    await handler([]);
    expect(runSampleFn).toHaveBeenCalledTimes(1);
  });

  it('core failure rethrows (pg-boss retry visibility)', async () => {
    vi.stubEnv(JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV, '1');
    const runSampleFn = vi.fn(async () => {
      throw new Error('batch exploded');
    });
    const resolveProviderFn = vi.fn();
    const handler = buildJudgeCalibrationSampleHandler(mockDb, {
      runSampleFn,
      resolveProviderFn,
    });
    await expect(handler([])).rejects.toThrow('batch exploded');
  });
});

describe('readJudgeCalibrationConfig', () => {
  it('defaults: anthropic-sub / claude-opus-4-8 / 20 / 7', () => {
    expect(readJudgeCalibrationConfig({})).toEqual(JUDGE_CALIBRATION_DEFAULTS);
  });

  it('env overrides are honored', () => {
    expect(
      readJudgeCalibrationConfig({
        JUDGE_CALIBRATION_REJUDGE_PROVIDER: 'xiaomi',
        JUDGE_CALIBRATION_REJUDGE_MODEL: 'mimo-v2.5',
        JUDGE_CALIBRATION_BATCH_MAX: '5',
        JUDGE_CALIBRATION_WINDOW_DAYS: '14',
      }),
    ).toEqual({
      rejudgeProvider: 'xiaomi',
      rejudgeModel: 'mimo-v2.5',
      batchMax: 5,
      windowDays: 14,
    });
  });

  it('garbage ints fall back to defaults; out-of-range clamps', () => {
    const cfg = readJudgeCalibrationConfig({
      JUDGE_CALIBRATION_BATCH_MAX: 'not-a-number',
      JUDGE_CALIBRATION_WINDOW_DAYS: '99999',
    });
    expect(cfg.batchMax).toBe(20);
    expect(cfg.windowDays).toBeLessThanOrEqual(90);
  });
});
