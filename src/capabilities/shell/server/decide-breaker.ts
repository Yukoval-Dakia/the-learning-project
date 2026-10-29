// 裁决（verdict）速率熔断读数：把窗口内的 rate 事件数归到 ok/warned/tripped
// 三档，供 A 档历史卡的 meter/banner 展示。A 档 auto-apply 自 YUK-525 起改为
// 人工审批，这里不再触发任何自动物化。
//
// 计数只从 `event.action='rate'` 派生（event log 是 SoT，不建表）。warn 只告知，
// max 是满刻度；阈值按正常裁决速率留足余量。
//
// 红线：只数 rate 速率，绝不触 θ̂ / p(L) / FSRS。

import { and, eq, gte, lte, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';

type DbLike = Db | Tx;

// 窗口 1h；warn=12、max=30 取正常裁决速率的数倍，正常使用碰不到。
export const VERDICT_RATE_WINDOW_MS = 3_600_000;
export const VERDICT_AUTOAPPLY_WARN = 12;
export const VERDICT_AUTOAPPLY_MAX = 30;

export type VerdictBreakerStatus = 'ok' | 'warned' | 'tripped';

export interface CheckVerdictRateBreakerInput {
  /** 窗口内已发生的裁决次数（含本次之前的，不含本次）。 */
  recentCount: number;
  /** warn 水位：达到/超过即 'warned'。默认 VERDICT_AUTOAPPLY_WARN。 */
  warn?: number;
  /** max 水位：达到/超过即 'tripped'。默认 VERDICT_AUTOAPPLY_MAX。 */
  max?: number;
}

/**
 * 纯判定（零 IO）：recentCount < warn → ok；≥ warn → warned；≥ max → tripped。
 * max 先于 warn 检查，故 warn === max 时只剩一条硬边界。
 */
export function checkVerdictRateBreaker(input: CheckVerdictRateBreakerInput): {
  status: VerdictBreakerStatus;
} {
  const warn = input.warn ?? VERDICT_AUTOAPPLY_WARN;
  const max = input.max ?? VERDICT_AUTOAPPLY_MAX;
  const count = input.recentCount;
  if (count >= max) return { status: 'tripped' };
  if (count >= warn) return { status: 'warned' };
  return { status: 'ok' };
}

export interface CountRecentVerdictsInput {
  /** 窗口右端（通常 = 本次 auto-apply 的 now）。 */
  now: Date;
  /** 窗口长度（ms）。默认 VERDICT_RATE_WINDOW_MS。 */
  windowMs?: number;
}

/**
 * 数窗口内 `event.action='rate'` 的行数（一条 rate = 一次裁决），只取 count。
 * 源是 rate 事件日志，绝不读 θ̂ / p(L) / FSRS 状态。
 */
export async function countRecentVerdicts(
  db: DbLike,
  input: CountRecentVerdictsInput,
): Promise<number> {
  const windowMs = input.windowMs ?? VERDICT_RATE_WINDOW_MS;
  const windowStart = new Date(input.now.getTime() - windowMs);
  // 上界 created_at <= now：未来时间的 rate 不进入「最近 1h」，避免虚高 meter。
  const rows = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(event)
    .where(
      and(
        eq(event.action, 'rate'),
        gte(event.created_at, windowStart),
        lte(event.created_at, input.now),
      ),
    );
  return rows[0]?.value ?? 0;
}

/** A 档 meter/banner 消费的熔断快照。 */
export interface VerdictBreakerResult {
  /** true → 已达 max 水位。 */
  tripped: boolean;
  /** 三档水位。 */
  level: VerdictBreakerStatus;
  /** 窗口内裁决次数（meter 当前水位）。 */
  applied: number;
  /** max 水位（meter 满刻度）。 */
  cap: number;
  /** 窗口长度（ms）。 */
  window: number;
}

/** 读取窗口内裁决数并归到熔断快照；计数函数可注入用于测试。 */
export async function checkAutoApplyBreaker(
  db: DbLike,
  now: Date,
  deps: { countRecentVerdicts?: (input: CountRecentVerdictsInput) => Promise<number> } = {},
): Promise<VerdictBreakerResult> {
  const count = deps.countRecentVerdicts
    ? await deps.countRecentVerdicts({ now })
    : await countRecentVerdicts(db, { now });
  const { status } = checkVerdictRateBreaker({ recentCount: count });
  return {
    tripped: status === 'tripped',
    level: status,
    applied: count,
    cap: VERDICT_AUTOAPPLY_MAX,
    window: VERDICT_RATE_WINDOW_MS,
  };
}
