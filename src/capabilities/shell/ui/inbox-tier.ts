// YUK-521 (A4 出手强度轴) — 收件箱三档分流的**纯视图逻辑**（无 DB / 无 React）。
//
// 抽出来让分桶 + 撤销窗口态判定在 no-DB unit 车道单测（effectiveness-trend-view.ts 范式）。
// InboxPage.tsx 从这里 import 同一套函数——单一真相，UI 与测试不漂移。
//
// 三档语义（强度轴，红线 — 与 accept-applier 轴 YUK-44 / tone 视觉轴正交）：
//   A 自动应用（completion；后台静默物化 + 撤销窗口，卡来自独立读模型 auto-applied-read）
//   B 逐条人审（真裁决项，复用 ProposalCard；含 breaker 退回 B 的 A-strength completion）
//   C 纯状态（无 accept applier 的 defer/archive/judge_retraction；折叠链到 AI 观察面）
//
// **tier 映射以 core 的强度表（aiProposalKindStrength）为单一真相**——设计稿 v0 的
// INBOX_TIER 把 record_* 放 A 是错的（它们是 LEGACY tombstone，归 B），故不照抄设计映射。

import { aiProposalKindStrength } from '@/core/schema/proposal';

// ── tier section header 文案（端口自 data-inbox-a4.jsx TIER_META；mapping 不照抄） ──
export interface TierMeta {
  label: string;
  sub: string;
  tone: 'good' | 'coral' | 'neutral';
}

export const TIER_META: Record<'A' | 'B' | 'C', TierMeta> = {
  A: {
    label: '自动应用',
    sub: '安全可逆 · 已静默应用 · 撤销窗口内一键回退',
    tone: 'good',
  },
  B: {
    label: '待你裁决',
    sub: '真裁决项 · 逐条 accept / dismiss · 每次写一条事件',
    tone: 'coral',
  },
  C: {
    label: '已自动处理',
    sub: '纯状态变更 · 不占裁决队列 · 可在旁观面回看',
    tone: 'neutral',
  },
};

// C-strength kinds（无 accept applier；从 core 强度表派生，单一真相防漂移）。
const C_STRENGTH_KINDS: ReadonlySet<string> = new Set(
  Object.entries(aiProposalKindStrength)
    .filter(([, strength]) => strength === 'C')
    .map(([kind]) => kind),
);

/**
 * 待裁决 proposal 是否归 C 块（纯状态、折叠移出裁决面）。未知 kind → false（落 B 块逐条
 * 人审），故一个意外 kind 永远不会被静默藏进折叠的 C 块（绝不丢卡）。
 */
export function isMovedOutKind(kind: string): boolean {
  return C_STRENGTH_KINDS.has(kind);
}

export interface TierBuckets<T> {
  /** B 块：真裁决项（B-strength + breaker 退回 B 的 A-strength completion + 未知 kind）。 */
  decide: T[];
  /** C 块：纯状态项（C-strength），折叠展示去向、不要求裁决。 */
  moved: T[];
}

/**
 * 把待裁决 proposal 行按强度分成「逐条人审（B 块）」+「纯状态（C 块）」两堆。
 * A 块的卡来自独立读模型（auto-applied events），不在 pending rows 里——故这里只二分。
 */
export function bucketPendingByTier<T extends { kind: string }>(
  rows: readonly T[],
): TierBuckets<T> {
  const decide: T[] = [];
  const moved: T[] = [];
  for (const row of rows) {
    if (isMovedOutKind(row.kind)) moved.push(row);
    else decide.push(row);
  }
  return { decide, moved };
}

// ── A 档撤销窗口态（时间基 v0）─────────────────────────────────────────────────
// 撤销窗口：apply 后这段时间内 'live'（一键干净撤回）；窗口过 → 'consumed'（视为已被
// 下游消费、不保证干净撤销——但 retract 车道仍可达，只是不再标 live）；已 retract → 'reverted'。
export const UNDO_WINDOW_MS = 10 * 60_000; // 10 min

export type AutoAppliedDisplayState = 'live' | 'consumed' | 'reverted';

/**
 * 纯判定（零 IO）：给定 apply 时刻 + now + 是否已撤销，决定 A 档卡的显示态。
 * reverted 优先（已撤销盖一切）；否则窗口内 live、窗口外 consumed。
 */
export function autoAppliedState(
  appliedAtMs: number,
  nowMs: number,
  reverted: boolean,
  windowMs: number = UNDO_WINDOW_MS,
): AutoAppliedDisplayState {
  if (reverted) return 'reverted';
  if (nowMs - appliedAtMs < windowMs) return 'live';
  return 'consumed';
}

/** live 态剩余可撤销毫秒（≤0 即已过窗口）。consumed/reverted 调用方不需要它。 */
export function undoRemainingMs(
  appliedAtMs: number,
  nowMs: number,
  windowMs: number = UNDO_WINDOW_MS,
): number {
  return Math.max(0, appliedAtMs + windowMs - nowMs);
}
