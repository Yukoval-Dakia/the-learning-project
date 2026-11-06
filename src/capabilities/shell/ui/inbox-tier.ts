// YUK-521 (A4 出手强度轴) — 收件箱三档分流的**纯视图逻辑**（无 DB / 无 React）。
//
// InboxPage.tsx 从这里 import 同一套分桶 + 撤销窗口态函数。
//
// 三档语义（强度轴，与 tone 视觉轴无关）：
//   A 自动应用（后台静默物化 + 撤销窗口，卡来自独立读模型 auto-applied-read）
//   B 逐条人审（真裁决项，复用 ProposalCard）
//   C 纯状态（无 accept applier；折叠链到 AI 观察面）
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
    sub: '已自动采用 · 还没被用到的可以撤销',
    tone: 'good',
  },
  B: {
    label: '待你裁决',
    sub: '需要你判断 · 逐条查看并作决定',
    tone: 'coral',
  },
  C: {
    label: '仅作观察',
    sub: '旁观记录 · 尚未执行 · 不需要你裁决',
    tone: 'neutral',
  },
};

/**
 * C 档只有 pending 观察记录，没有 accept applier，也没有目标 mutation。文案集中在这里，
 * 避免 UI 把“从裁决队列移出”误写成“已经执行”。
 */
export const TIER_C_COPY = {
  summary: (count: number) => `${count} 项旁观记录，未执行变更`,
  collapsed: '展开查看提议内容 · 不需要你裁决',
  expanded: '这些提议仍只是待定记录，没有修改任何目标数据',
  itemState: '仅记录 · 未执行',
} as const;

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

export interface KindCountsByTier {
  /** 待你裁决的 kind（含未知 kind），数量降序。 */
  decide: Array<[kind: string, count: number]>;
  /** 仅作观察的 kind（C 档），数量降序。 */
  observe: Array<[kind: string, count: number]>;
  decideTotal: number;
  observeTotal: number;
}

/** 把全部 pending 计数按档位分组，一项都不丢；今日页按这个顺序显示并用文字说明档位。 */
export function kindCountsByTier(byKind: Readonly<Record<string, number>>): KindCountsByTier {
  const entries = Object.entries(byKind)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const decide = entries.filter(([kind]) => !isMovedOutKind(kind));
  const observe = entries.filter(([kind]) => isMovedOutKind(kind));
  const sum = (rows: Array<[string, number]>) => rows.reduce((total, [, n]) => total + n, 0);
  return { decide, observe, decideTotal: sum(decide), observeTotal: sum(observe) };
}

// ── 替你做了什么：摘要的时间窗 ─────────────────────────────────────────────────
export type AutoAppliedWindowKey = 'today' | 'yesterday' | 'week';
export const AUTO_APPLIED_WINDOWS: readonly { key: AutoAppliedWindowKey; label: string }[] = [
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨天' },
  { key: 'week', label: '近 7 天' },
];

const WEEK_DAYS_BACK = 6;

function localDayStart(now: Date, daysAgo: number): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo).getTime();
}

/** The page reads the whole week once, so history stays reachable when today is empty. */
export function autoAppliedReadWindow(now: Date = new Date()): { from: string } {
  return { from: new Date(localDayStart(now, WEEK_DAYS_BACK)).toISOString() };
}

export function isInAutoAppliedWindow(
  appliedAt: string,
  key: AutoAppliedWindowKey,
  now: Date = new Date(),
): boolean {
  const at = new Date(appliedAt).getTime();
  const today = localDayStart(now, 0);
  if (key === 'today') return at >= today;
  if (key === 'yesterday') return at >= localDayStart(now, 1) && at < today;
  return at >= localDayStart(now, WEEK_DAYS_BACK);
}
