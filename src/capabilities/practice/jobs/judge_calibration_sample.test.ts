// YUK-1355 — retained judge_calibration_sample pg-boss handler, unit tests.
// The handler is now a thin consumer of the extracted operation; these pins
// hold its observable contract in place: disabled log face, result log, the
// failed-log-only-for-batch-errors distinction, and the rethrow that drives
// pg-boss retry.

import type { Job } from 'pg-boss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetTestConfig, setTestConfig } from '@/core/config/store';
import { db } from '@/db/client';
import type { JudgeCalibrationSampleResult } from '../server/judge-calibration-sample-core';
import { buildJudgeCalibrationSampleHandler } from './judge_calibration_sample';
import { JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV } from './judge-calibration-config';

const CFG = {
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
const jobs: Job<Record<string, never>>[] = [];

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  resetTestConfig();
  vi.restoreAllMocks();
});

describe('buildJudgeCalibrationSampleHandler', () => {
  // @invariant data: disabled sampling cannot spend through the retained handler
  // @fails-if bypass the disabled gate; the batch executes despite the flag
  it('disabled — logs the historical face and returns cleanly', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: false });
    const runSampleFn = vi.fn();
    await buildJudgeCalibrationSampleHandler(db, {
      config: CFG,
      resolveProviderFn: () => {},
      runSampleFn,
    })(jobs);
    // @invariant the dark-ship face stays verbatim (operator greppability)
    expect(console.log).toHaveBeenCalledWith(
      `[judge_calibration_sample] disabled (${JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV}=undefined)`,
    );
    // @invariant data: zero paid batches while OFF
    expect(runSampleFn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  // @invariant data: the retained handler runs one batch with unchanged dependencies
  // @fails-if omit or duplicate the extracted operation call; the batch count differs
  it('sampled — logs the result through the operation seam', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const runSampleFn = vi.fn(async () => RESULT);
    await buildJudgeCalibrationSampleHandler(db, {
      config: CFG,
      resolveProviderFn: () => {},
      runSampleFn,
    })(jobs);
    expect(runSampleFn).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith('[judge_calibration_sample] result', RESULT);
  });

  // @invariant data: batch failure remains visible to the existing queue owner
  // @fails-if swallow the batch error; the handler resolves instead of rejecting
  it('batch failure — logs failed and rethrows for pg-boss retry', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    const runSampleFn = vi.fn(async () => {
      throw new Error('batch exploded');
    });
    // @fails-if the handler swallows the batch error: the pg-boss retry contract dies
    await expect(
      buildJudgeCalibrationSampleHandler(db, {
        config: CFG,
        resolveProviderFn: () => {},
        runSampleFn,
      })(jobs),
    ).rejects.toThrow('batch exploded');
    expect(console.error).toHaveBeenCalledWith(
      '[judge_calibration_sample] failed',
      expect.objectContaining({ message: 'batch exploded' }),
    );
  });

  // @invariant data: a dead second lane cannot start sampling or fallback work
  // @fails-if swallow preflight failure; the handler resolves or reaches the batch
  it('pre-flight failure — rethrows bare, WITHOUT the batch failed log', async () => {
    setTestConfig({ [JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV]: true });
    // @invariant a dead second lane is a gate failure face, not a batch face —
    // the historical distinction the MF3① comment documents
    await expect(
      buildJudgeCalibrationSampleHandler(db, {
        config: CFG,
        resolveProviderFn: () => {
          throw new Error('missing CLAUDE_CODE_OAUTH_TOKEN');
        },
      })(jobs),
    ).rejects.toThrow('missing CLAUDE_CODE_OAUTH_TOKEN');
    expect(console.error).not.toHaveBeenCalled();
  });
});
