// YUK-358 / ADR-0040 决定1 — A 档 auto-apply 速率熔断器。
//
// ADR-0040 line 14 / 18 / 58：把小可逆 note refine 下放到 A 档（自动应用 + 撤销
// 窗口）的配套护栏之一是「单位时间**熔断**」——见 ADR-0039 A 档 strength tier。
// 当 note_refine AI mutator 在单位时间窗口内 auto-apply 次数失控（bug / 触发风暴 /
// dreaming 扫全库），熔断退回**全人审**：不再静默改 artifact，而是把同一 patch 经
// 既有 writeNoteRefineProposal 落进 inbox 让人审批。
//
// 两层语义（红线，与 stream-composer.ts R5 容量护栏同构）：
//   - warn 水位：**零干预只告知** —— 仍 auto-apply，只多埋一条可观测 event
//     （experimental:note_refine_autoapply_warned），让 owner 看到速率在抬头。
//   - max 硬顶：退回人审（**NOT block** —— 用户仍能在 inbox accept 那条 proposal）。
//     这是「防事故硬顶」，不是「卡死正常重型使用」：阈值定在正常速率（~2-3/h）的
//     ~3-5× 处，正常 mark_wrong / mastery_change 触发的 refine 永远碰不到。
//
// **NO new table**（ADR-0006 event log 是 SoT，建表会违 audit:schema）：计数从
// `experimental:note_refine_apply` event 派生——镜像 listNoteRefineChanges 的
// count 形状（note-refine-apply.ts ~221-233）。只数 actor_ref='note_refine' 的
// AI mutator apply，排除 accept-path（actor_ref='note_refine_accept'，那是人审
// 批后的落盘，不该计入「AI 自动应用速率」）。
//
// 红线：熔断只数 apply event 速率——绝不触 θ̂ / p(L) / FSRS（ADR-0035 soft-track
// 隔离）。

import { and, eq, gte, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { NOTE_REFINE_AUTOAPPLY_ACTOR } from './note-refine-apply';

type DbLike = Db | Tx;

// 阈值 module-const + override seam（mirror stream-composer DEFAULT_WARN/MAX）。
// 窗口 1h；warn=8、max=20 ≈ 正常 ~2-3/h 的 ~3-5×（ADR-0040 决定1 A 档配套）。
export const REFINE_RATE_WINDOW_MS = 3_600_000;
export const REFINE_AUTOAPPLY_WARN = 8;
export const REFINE_AUTOAPPLY_MAX = 20;

export type AutoApplyBreakerStatus = 'ok' | 'warned' | 'tripped';

export interface CheckAutoApplyBreakerInput {
  /** 窗口内已发生的 AI auto-apply 次数（含本次之前的，不含本次）。 */
  recentCount: number;
  /** warn 水位：达到/超过即 'warned'（仍 apply）。默认 REFINE_AUTOAPPLY_WARN。 */
  warn?: number;
  /** max 硬顶：达到/超过即 'tripped'（退回人审）。默认 REFINE_AUTOAPPLY_MAX。 */
  max?: number;
}

/**
 * 纯判定（零 IO）：给定窗口内已应用次数，决定本次 auto-apply 的护栏档位。
 *
 * 边界（off-by-one，与 unit test 互为 spec）：
 *   - recentCount < warn            → 'ok'      （正常 auto-apply）
 *   - warn ≤ recentCount < max      → 'warned'  （仍 auto-apply + 埋点）
 *   - recentCount ≥ max             → 'tripped' （退回人审）
 *
 * 即：第 `warn` 次 apply（recentCount===warn）起进 warned；第 `max` 次
 * （recentCount===max）起 trip。两层语义见模块头注。
 */
export function checkAutoApplyBreaker(input: CheckAutoApplyBreakerInput): {
  status: AutoApplyBreakerStatus;
} {
  const warn = input.warn ?? REFINE_AUTOAPPLY_WARN;
  const max = input.max ?? REFINE_AUTOAPPLY_MAX;
  const count = input.recentCount;
  if (count >= max) return { status: 'tripped' };
  if (count >= warn) return { status: 'warned' };
  return { status: 'ok' };
}

export interface CountRecentAutoAppliesInput {
  /** 窗口右端（通常 = 本次 refine 的 now）。 */
  now: Date;
  /** 窗口长度（ms）。默认 REFINE_RATE_WINDOW_MS。 */
  windowMs?: number;
  /** 计入的 actor_ref。默认 AI mutator（'note_refine'），排除 accept-path。 */
  actorRef?: string;
}

/**
 * 数 `experimental:note_refine_apply` event 中 created_at >= now - window 且
 * actor_ref = actorRef（默认 'note_refine' AI mutator）的行数。
 *
 * 镜像 listNoteRefineChanges 的 where 形状（同 action 谓词 + created_at gte），
 * 但只取 count——不 hydrate payload / undo 链。**排除 accept-path**
 * （actor_ref='note_refine_accept'）：那是人审批后的落盘，计入会让人审批本身把
 * 熔断推向 trip，语义错。
 */
export async function countRecentAutoApplies(
  db: DbLike,
  input: CountRecentAutoAppliesInput,
): Promise<number> {
  const windowMs = input.windowMs ?? REFINE_RATE_WINDOW_MS;
  const actorRef = input.actorRef ?? NOTE_REFINE_AUTOAPPLY_ACTOR;
  const windowStart = new Date(input.now.getTime() - windowMs);
  const rows = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:note_refine_apply'),
        eq(event.actor_ref, actorRef),
        gte(event.created_at, windowStart),
      ),
    );
  return rows[0]?.value ?? 0;
}
