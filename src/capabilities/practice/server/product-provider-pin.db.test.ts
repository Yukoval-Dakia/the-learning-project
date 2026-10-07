import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetTestConfig } from '@/core/config/store';
import { AgentRunError } from '@/server/ai/agent-run-error';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { readJudgeCalibrationConfig } from '../jobs/judge-calibration-config';
import { runTaskWithLaneFallback } from './judge/provider-lane-fallback';

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  resetTestConfig();
  vi.unstubAllEnvs();
});

it('a pinned vision provider failure never retries the same pin as a registry fallback', async () => {
  vi.stubEnv('AI_PROVIDER_OVERRIDE', 'opencode-go');
  vi.stubEnv('AI_PROVIDER_MODEL', 'mimo-v2.6-pro');
  vi.stubEnv('VISION_JUDGE_PROVIDER', 'anthropic-sub');
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'dummy-old-token');
  const runTaskFn = vi.fn(async () => {
    throw new AgentRunError({
      kind: 'StepsJudgeTask',
      taskRunId: 'synthetic-402',
      subtype: 'api_error_result',
      errors: ['HTTP 402'],
      apiErrorStatus: 402,
    });
  });
  const result = await runTaskWithLaneFallback({
    kind: 'StepsJudgeTask',
    input: { text: 'synthetic derivation', images: [] },
    baseCtx: { db: testDb() },
    runTaskFn,
  });
  expect(runTaskFn).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ ok: false, hardFailure: { failed_lane: 'opencode-go' } });
});

it('calibration provenance records the product pin rather than a masked legacy rejudge config', () => {
  const config = readJudgeCalibrationConfig({
    AI_PROVIDER_OVERRIDE: 'opencode-go',
    AI_PROVIDER_MODEL: 'mimo-v2.6-pro',
    JUDGE_CALIBRATION_REJUDGE_PROVIDER: 'anthropic-sub',
    JUDGE_CALIBRATION_REJUDGE_MODEL: 'claude-opus-4-8',
  });
  expect(config).toMatchObject({ rejudgeProvider: 'opencode-go', rejudgeModel: 'mimo-v2.6-pro' });
});
