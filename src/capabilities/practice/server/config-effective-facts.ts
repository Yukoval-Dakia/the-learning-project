// YUK-1007 — practice 拥有键的 consumer-effective 事实（单一真相：逐键调用
// 真实 reader，绝不复述 clamp/fallback 规则）。经 practice/public.ts 透出，
// 供组合根 facts seam（server/config/admin-config-facts.ts）聚合进
// GET /api/admin/config 的 keys[].effective——capability 边界审计只放行
// server→public 入口，deep import 会被 ratchet 拦下。

import type { ConfigEffectiveFacts } from '@/core/config/effective';
import { readJudgeCalibrationConfig } from '../jobs/judge-calibration-config';
import { judgeFallbackProvider } from './judge-durable-config';
import { jyeooDailyFetchBudget } from './question-supply/jyeoo-budget';
import {
  jyeooBinaryPath,
  jyeooSpawnMaxStderrBytes,
  jyeooSpawnMaxStdoutBytes,
  jyeooSpawnTimeoutMs,
} from './question-supply/jyeoo-supply-config';

export function practiceConfigEffectiveFacts(): ConfigEffectiveFacts {
  const calibration = readJudgeCalibrationConfig();
  const fallbackProvider = judgeFallbackProvider();
  const spawnTimeoutMs = jyeooSpawnTimeoutMs();
  return {
    JUDGE_CALIBRATION_BATCH_MAX: { value: calibration.batchMax },
    JUDGE_CALIBRATION_WINDOW_DAYS: { value: calibration.windowDays },
    JUDGE_CALIBRATION_REJUDGE_PROVIDER: { value: calibration.rejudgeProvider },
    JUDGE_CALIBRATION_REJUDGE_MODEL: { value: calibration.rejudgeModel },
    JUDGE_FALLBACK_PROVIDER:
      fallbackProvider === undefined
        ? {
            value: null,
            note: 'reader 降级为不切换（显式空串/非法名/未接线/registry 默认 model 不可跑 → 无跨 provider 兜底）',
          }
        : { value: fallbackProvider },
    JYEOO_RS_BINARY: { value: jyeooBinaryPath() },
    JYEOO_SPAWN_TIMEOUT_MS: Number.isFinite(spawnTimeoutMs)
      ? { value: spawnTimeoutMs }
      : {
          value: null,
          note: 'NaN 直通 fail-closed（YUK-990）：reader 不 clamp，spawn 即败以暴露坏配置',
        },
    JYEOO_SPAWN_MAX_STDOUT_BYTES: { value: jyeooSpawnMaxStdoutBytes() },
    JYEOO_SPAWN_MAX_STDERR_BYTES: { value: jyeooSpawnMaxStderrBytes() },
    JYEOO_DAILY_FETCH_BUDGET: { value: jyeooDailyFetchBudget() },
    JYEOO_BACKFILL_TIMEOUT_MS: {
      note: '按会话动态派生（jyeooBackfillSpawnTimeoutMs(sessionMax)：BACKFILL > SPAWN > sessionMax×90s），无单一标量 effective',
    },
  };
}
