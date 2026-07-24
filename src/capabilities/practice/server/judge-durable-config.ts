// YUK-594 (durable judge main path) — durable judge_run 的运行时开关 + lane 常量。
//
// 集中读 env（*_ENABLED ledger 惯例 + 共享 parseFlag），让 submit 面分流、handler
// kill-switch、pnpm audit:flags 对账三处引同一 reader，不各写一份 truthiness。

import type { Provider } from '@/ai/registry';
import { parseFlag } from '@/core/env-flags';

/** boss 队列名（handlers.ts 注册 + submit 面 boss.send + status 路由共享）。 */
export const JUDGE_RUN_QUEUE = 'judge_run' as const;

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
 * 返回 undefined ⇒ 不切 provider（保持默认 mimo lane）。默认值经校验必须是已知
 * provider，否则 fail-fast（防打错 provider 名静默降级）。
 */
export function judgeFallbackProvider(): Provider | undefined {
  const raw = process.env.JUDGE_FALLBACK_PROVIDER?.trim();
  // 默认 anthropic-sub；显式设空串 ⇒ 关闭跨 provider 兜底（留 undefined）。
  const name = raw === undefined ? 'anthropic-sub' : raw === '' ? undefined : raw;
  return name as Provider | undefined;
}

/**
 * 跨 provider 兜底的 lane 决策：仅在 durable 重试的**最后一次**投递上切 fallback
 * provider，且该 provider 的凭据已配置时才切（未配则保持默认 lane，绝不因缺 token
 * 让判分整体炸掉 → 有界降级）。attempt 序列（JOB_RETRY_LIMIT=2）：
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
  // 有界降级：fallback provider 凭据缺失（如 anthropic-sub 无 CLAUDE_CODE_OAUTH_TOKEN）
  // 时不切——resolveTaskProvider 会因缺 token throw，切了反而把最后一次重投也判死。
  if (!fallbackProviderConfigured(fallback)) return undefined;
  return fallback;
}

/**
 * fallback provider 的凭据是否就位。anthropic-sub 需 CLAUDE_CODE_OAUTH_TOKEN；
 * key-auth provider 需其 apiKey env。无法确定的 provider 名 ⇒ 视为未配置（保守）。
 */
function fallbackProviderConfigured(provider: Provider): boolean {
  if (provider === 'anthropic-sub') return Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  const envByProvider: Partial<Record<Provider, string>> = {
    anthropic: 'ANTHROPIC_API_KEY',
    xiaomi: 'XIAOMI_API_KEY',
    zhipu: 'ZHIPU_API_KEY',
  };
  const envName = envByProvider[provider];
  return envName ? Boolean(process.env[envName]) : false;
}
