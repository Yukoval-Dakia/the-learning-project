// YUK-521 / ADR-0039 A 档 strength tier — 裁决（verdict）速率熔断器。
//
// A 档 auto-apply（completion 自动物化 + 撤销窗口）的配套护栏：当裁决 rate 在单位
// 时间窗口内失控（bug / 触发风暴 / dreaming 扫全库），熔断退回**全人审**——本次
// completion 不自动物化，而是退回 B 档留 pending 让人审批。
//
// 两层语义（红线，与 note-refine-breaker.ts / stream-composer R5 容量护栏同构）：
//   - warn 水位：**零干预只告知** —— 仍 auto-apply，只多埋一条可观测 event，
//     让 owner 看到速率在抬头。
//   - max 硬顶：退回人审（**NOT block** —— 用户仍能在 inbox accept 那条 proposal）。
//     这是「防事故硬顶」，不是「卡死正常重型使用」：阈值定在正常裁决速率的 ~3-5×
//     处（禁单一紧硬 cap，护栏两层语义），正常使用永远碰不到。
//
// **NO new table**（ADR-0006 event log 是 SoT，建表会违 audit:schema）：计数从
// `event.action='rate'` 派生——裁决 rate 事件就是「一次决策」的规范信号。
//
// 红线：熔断只数 rate 事件速率——**绝不触 θ̂ / p(L) / FSRS**（ADR-0035 soft-track
// 隔离）。强度轴 ≠ accept-applier 轴 ≠ tone 视觉轴，三轴勿耦合。

import { and, eq, gte, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';

type DbLike = Db | Tx;

// 阈值 module-const + override seam（mirror note-refine-breaker DEFAULT_WARN/MAX）。
// 窗口 1h；warn=12、max=30 ≈ 正常裁决速率的 ~3-5×（护栏两层：warn 只告知、max 硬顶）。
export const VERDICT_RATE_WINDOW_MS = 3_600_000;
export const VERDICT_AUTOAPPLY_WARN = 12;
export const VERDICT_AUTOAPPLY_MAX = 30;

export type VerdictBreakerStatus = 'ok' | 'warned' | 'tripped';

export interface CheckVerdictRateBreakerInput {
  /** 窗口内已发生的裁决次数（含本次之前的，不含本次）。 */
  recentCount: number;
  /** warn 水位：达到/超过即 'warned'（仍 auto-apply）。默认 VERDICT_AUTOAPPLY_WARN。 */
  warn?: number;
  /** max 硬顶：达到/超过即 'tripped'（退回人审）。默认 VERDICT_AUTOAPPLY_MAX。 */
  max?: number;
}

/**
 * 纯判定（零 IO）：给定窗口内已裁决次数，决定本次 A 档 auto-apply 的护栏档位。
 *
 * 边界（off-by-one，与 unit test 互为 spec，镜像 note-refine-breaker）：
 *   - recentCount < warn            → 'ok'      （正常 auto-apply）
 *   - warn ≤ recentCount < max      → 'warned'  （仍 auto-apply + 埋点）
 *   - recentCount ≥ max             → 'tripped' （退回人审）
 *
 * 即：第 `warn` 次（recentCount===warn）起进 warned；第 `max` 次
 * （recentCount===max）起 trip。max 先于 warn 检查，warn===max 时塌成单硬边界。
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
 * 数 `event.action='rate'` 中 created_at >= now - window 的行数。一条 rate 事件 =
 * 一次裁决（accept/dismiss/reverse）。只取 count——不 hydrate payload。
 *
 * 红线：源是 rate 事件日志，**绝不**读 θ̂ / p(L) / FSRS 状态。
 */
export async function countRecentVerdicts(
  db: DbLike,
  input: CountRecentVerdictsInput,
): Promise<number> {
  const windowMs = input.windowMs ?? VERDICT_RATE_WINDOW_MS;
  const windowStart = new Date(input.now.getTime() - windowMs);
  const rows = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(event)
    .where(and(eq(event.action, 'rate'), gte(event.created_at, windowStart)));
  return rows[0]?.value ?? 0;
}

/** A 档 auto-apply 触发点消费的熔断快照（read 模型也透传 cap/window/level 给 UI meter）。 */
export interface VerdictBreakerResult {
  /** true → 退回人审（本次 completion 不 auto-apply，留 pending）。 */
  tripped: boolean;
  /** 三档档位（'ok' | 'warned' | 'tripped'）。 */
  level: VerdictBreakerStatus;
  /** 窗口内已发生的裁决次数（meter 的当前水位）。 */
  applied: number;
  /** max 硬顶（meter 的满刻度）。 */
  cap: number;
  /** 窗口长度（ms）。 */
  window: number;
}

/**
 * DB-backed 复合判定：数窗口内裁决 → 纯档位判定 → 打包成 A 档触发点 + UI meter 都
 * 消费的快照。countRecentVerdicts 可注入（测试），默认走 DB。
 */
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
