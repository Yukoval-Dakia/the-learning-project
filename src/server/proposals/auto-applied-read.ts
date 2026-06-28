// YUK-521 (A4 强度轴 / ADR-0039 A 档) — A 档 auto-applied 卡的只读读模型。
//
// 数据源 = `experimental:completion_autoapply` 事件（completion 工具 auto-apply 成功后
// 写的锚，payload 带 proposal_id + breaker 快照）。每条 join 是否有对应 `correct`(retract)
// 事件（subject=proposalId、correction_kind='retract'）判 reverted——撤销复用既有
// retractAiProposal 车道（无新撤销逻辑），这里只读它留下的 correct 事件痕迹。
//
// 同时透传**当前**裁决熔断快照（checkAutoApplyBreaker）供 A 块 meter/banner 渲染。
//
// 红线：只读 event 日志（autoapply 锚 + correct 痕 + rate 速率），绝不触 θ̂ / p(L) / FSRS。

import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { event, learning_item } from '@/db/schema';
import { COMPLETION_AUTOAPPLY_ACTION } from './completion-autoapply-actions';
import { type VerdictBreakerStatus, checkAutoApplyBreaker } from './decide-breaker';

type DbLike = Db | Tx;

// 列表窗口：默认回看 24h（远长于撤销窗口——前端 autoAppliedState 用更短的 UNDO_WINDOW_MS
// 区分 live/consumed；这里只决定哪些卡进列表）。
export const AUTO_APPLIED_LIST_WINDOW_MS = 24 * 3_600_000;
// 读查询行数上界（退化防御）：裁决熔断器（checkAutoApplyBreaker）正常已把 auto-apply 速率
// 压在 VERDICT_AUTOAPPLY_MAX 量级，24h 窗口内的 auto-applied 锚远不及此数；limit 仅防异常
// 风暴（bug / 回填）下一次性拉爆列表，非业务上限。
export const AUTO_APPLIED_MAX_ROWS = 200;

export interface AutoAppliedRow {
  proposal_id: string;
  learning_item_id: string;
  /** 学习项标题（已删/缺失 → fallback 到 id）。 */
  title: string;
  /** apply 时刻（ISO）；前端据此 + now 判 live/consumed。 */
  applied_at: string;
  /** apply 时的熔断档位（'ok' | 'warned' | 'tripped'）。 */
  level: VerdictBreakerStatus;
  /** 是否已被既有 retract 车道撤销（有对应 correct 事件）。 */
  reverted: boolean;
}

export interface AutoAppliedDigest {
  rows: AutoAppliedRow[];
  /** 当前熔断快照（A 块 meter/banner）。 */
  breaker: {
    tripped: boolean;
    level: VerdictBreakerStatus;
    applied: number;
    cap: number;
    window: number;
  };
}

export async function getAutoAppliedDigest(
  db: DbLike,
  opts: { now?: Date; windowMs?: number } = {},
): Promise<AutoAppliedDigest> {
  const now = opts.now ?? new Date();
  const windowMs = opts.windowMs ?? AUTO_APPLIED_LIST_WINDOW_MS;
  const windowStart = new Date(now.getTime() - windowMs);

  // breaker 快照与「rows + retracted」整体无依赖，并行取（rows→retracted 内部仍串行，
  // 因 loadRetractedSet 依赖 rows 的 proposalIds）。
  const [{ rows, revertedSet }, breaker] = await Promise.all([
    loadAutoAppliedRows(db, windowStart),
    checkAutoApplyBreaker(db, now),
  ]);

  const out: AutoAppliedRow[] = rows.flatMap((r) => {
    const proposalId = readProposalId(r.payload);
    // 跳过缺 proposal_id 的坏锚事件——A 档 UI 靠稳定 proposal id 做 key / 撤销入口，
    // 投影成 proposal_id:'' 的脏卡会破坏 key 且无法撤销（CodeRabbit #6）。
    if (proposalId.length === 0) return [];
    return [
      {
        proposal_id: proposalId,
        learning_item_id: r.subjectId,
        title: r.title ?? r.subjectId,
        applied_at: r.createdAt.toISOString(),
        level: readLevel(r.payload),
        reverted: revertedSet.has(proposalId),
      },
    ];
  });

  return {
    rows: out,
    breaker: {
      tripped: breaker.tripped,
      level: breaker.level,
      applied: breaker.applied,
      cap: breaker.cap,
      window: breaker.window,
    },
  };
}

/**
 * A 档列表行 + 其 retracted 集合。rows → retracted 内部串行（loadRetractedSet 依赖 rows 抽出
 * 的 proposalIds）；整体与 breaker 查询无依赖，故由调用方与 checkAutoApplyBreaker 并行取。
 */
async function loadAutoAppliedRows(db: DbLike, windowStart: Date) {
  const rows = await db
    .select({
      subjectId: event.subject_id,
      payload: event.payload,
      createdAt: event.created_at,
      title: learning_item.title,
    })
    .from(event)
    .leftJoin(learning_item, eq(learning_item.id, event.subject_id))
    .where(and(eq(event.action, COMPLETION_AUTOAPPLY_ACTION), gte(event.created_at, windowStart)))
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(AUTO_APPLIED_MAX_ROWS);

  const proposalIds = rows
    .map((r) => readProposalId(r.payload))
    .filter((id): id is string => id.length > 0);
  const revertedSet = await loadRetractedSet(db, proposalIds);
  return { rows, revertedSet };
}

function readProposalId(payload: unknown): string {
  const value = (payload as { proposal_id?: unknown } | null)?.proposal_id;
  return typeof value === 'string' ? value : '';
}

// 合法熔断档位集合——解析 payload.level 后 narrow（非法/缺失值落 'ok'，与读模型契约一致）。
const VALID_BREAKER_STATUSES: ReadonlySet<VerdictBreakerStatus> = new Set([
  'ok',
  'warned',
  'tripped',
]);

function readLevel(payload: unknown): VerdictBreakerStatus {
  const value = (payload as { level?: unknown } | null)?.level;
  if (typeof value === 'string' && VALID_BREAKER_STATUSES.has(value as VerdictBreakerStatus)) {
    return value as VerdictBreakerStatus;
  }
  return 'ok';
}

/** proposalIds 中已被 retract（correct + correction_kind='retract'）的集合。 */
async function loadRetractedSet(db: DbLike, proposalIds: string[]): Promise<Set<string>> {
  if (proposalIds.length === 0) return new Set();
  const rows = await db
    .select({ subjectId: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.action, 'correct'),
        eq(event.subject_kind, 'event'),
        inArray(event.subject_id, proposalIds),
        sql`${event.payload} ->> 'correction_kind' = 'retract'`,
      ),
    );
  return new Set(rows.map((r) => r.subjectId));
}
