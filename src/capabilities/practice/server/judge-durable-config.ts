// YUK-594 (durable judge main path) — durable judge_run 的运行时开关 + lane 常量。
//
// 集中读 env（*_ENABLED ledger 惯例 + 共享 parseFlag），让 submit 面分流、handler
// kill-switch、pnpm audit:flags 对账三处引同一 reader，不各写一份 truthiness。

import type { Provider } from '@/ai/registry';
import { parseFlag } from '@/core/env-flags';
import { isProviderImplemented, isProviderLaneReady } from '@/server/ai/providers';

/** boss 队列名（handlers.ts 注册 + submit 面 boss.send + status 路由共享）。 */
export const JUDGE_RUN_QUEUE = 'judge_run' as const;

/** 默认跨 provider 兜底 lane（#10 — 单一常量，避免字面量双站点漂移）。 */
export const DEFAULT_JUDGE_FALLBACK_PROVIDER: Provider = 'anthropic-sub';

/**
 * YUK-594 (D8) — 异步为主路径的 kill switch。默认 OFF（dark-ship）：flag off 时
 * submit 面走既有同步判分（byte-identical 回归锚）；翻 ON 后 submit 的服务端判分
 * 调用改为投 judge_run + 返回 202 pending，判词经回填事务落库。
 *
 * Opt-in / 默认 OFF；经共享 parseFlag（'true'/'1' 开，其余保守 OFF）。
 */
export function judgeDurableEnabled(): boolean {
  return parseFlag(process.env.JUDGE_DURABLE_ENABLED);
}

/**
 * YUK-594 (D7/D9) — 跨 provider 兜底 lane。durable 重试耗尽前的最后一次重投切到
 * 此 provider（默认 anthropic-sub = Opus 4.8 via owner Claude Max OAuth），复用
 * RunTaskCtx.override（providers.ts resolveTaskProvider 既有 per-call seam），不发明
 * 新 plumbing。仅在最后一次重投应用（有界：付费调用 ≤ 1 + JOB_RETRY_LIMIT）。
 *
 * 返回 undefined ⇒ 不切 provider（保持默认 mimo lane）。
 *
 * #3 — provider 名经 real 校验（isProviderImplemented 单一真源，YUK-608），但**非法
 * 配置降级+log、绝不 throw**：这函数在 handler 判分路径里（最后一次重投时）调用，
 * 抛裸 Error 会被 catch 当 retryable 误判、写乱终态。misconfig 是 operator 错，不该
 * 让判分整体炸——记一条 warn、返回 undefined（不切 provider，走默认 lane）即可。
 */
export function judgeFallbackProvider(): Provider | undefined {
  const raw = process.env.JUDGE_FALLBACK_PROVIDER?.trim();
  if (raw === '') return undefined; // 显式空串 ⇒ 关闭跨 provider 兜底。
  if (raw === undefined) return DEFAULT_JUDGE_FALLBACK_PROVIDER;
  // Real validation (not an `as Provider` cast) via the single-source predicate. On a
  // misconfigured name: DEGRADE (warn + no fallback), never throw — a throw here would
  // land in the handler's catch on the FINAL delivery and be mis-classified retryable.
  if (!isProviderImplemented(raw as Provider)) {
    console.warn(
      `[judge_run] ignoring invalid JUDGE_FALLBACK_PROVIDER='${raw}' (not a wired provider) — no cross-provider fallback this run`,
    );
    return undefined;
  }
  return raw as Provider;
}

/**
 * 跨 provider 兜底的 lane 决策：仅在 durable 重试的**最后一次**投递上切 fallback
 * provider，且该 provider 的 lane 就绪（凭据配齐）才切（未配则保持默认 lane，绝不
 * 因缺 token 把最后一次重投也判死 → 有界降级）。attempt 序列（JOB_RETRY_LIMIT=2）：
 *   retryCount 0 = mimo（首发）、1 = mimo（transient 重投）、2 = anthropic-sub（终局）。
 */
export function resolveDurableProviderOverride(params: {
  retryCount: number;
  retryLimit: number;
}): Provider | undefined {
  const { retryCount, retryLimit } = params;
  if (!Number.isFinite(retryCount) || !Number.isFinite(retryLimit)) return undefined;
  if (retryCount < retryLimit) return undefined; // 未到最后一次投递 → 不切。
  const fallback = judgeFallbackProvider();
  if (!fallback) return undefined;
  // #6 — reuse the exported lane-readiness predicate (credentials present) instead of a
  // second hard-coded env map. judgeFallbackProvider already ensured it's wired; this is
  // the bounded degrade: missing creds → stay on the default lane.
  if (!isProviderLaneReady(fallback)) return undefined;
  return fallback;
}
