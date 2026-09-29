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
import { resolveSolveOverrideFromEnv } from './quiz/solve-lane';

export function practiceConfigEffectiveFacts(): ConfigEffectiveFacts {
  const calibration = readJudgeCalibrationConfig();
  const fallbackProvider = judgeFallbackProvider();
  const spawnTimeoutMs = jyeooSpawnTimeoutMs();
  // YUK-1007 P1（验证审反例）：solve-lane 覆盖的 effective 必须来自真实 reader
  // （solve-lane.ts resolveSolveOverrideFromEnv——凭据缺失/未知名/缺 model 时
  // fail-open 返回 {}）。降级说明直接取 reader 自己的 warn 文本（注入收集器，
  // 读面轮询不重复打 operator 日志；降级事实进 payload）。
  let solveDegradeNote: string | undefined;
  const solveOverride = resolveSolveOverrideFromEnv((message) => {
    solveDegradeNote = message;
  });
  const solveProviderActive = solveOverride.provider !== undefined;
  const solveModelActive = solveOverride.model !== undefined;
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
    'lane.verify_solve.provider': solveProviderActive
      ? { value: solveOverride.provider }
      : {
          value: null,
          note: solveDegradeNote ?? 'override 未设置（reader 返回空 ⇒ verify_check 走默认 lane）',
        },
    'lane.verify_solve.model': solveModelActive
      ? { value: solveOverride.model }
      : {
          value: null,
          note: solveDegradeNote
            ? `${solveDegradeNote}（model 随 provider 一起被丢弃——它是为该 provider 选的）`
            : solveProviderActive
              ? '仅 provider 生效：model 未设置，走该 provider 的默认 model 解析链'
              : 'override 未设置（reader 返回空 ⇒ verify_check 走默认 lane）',
        },
  };
}
