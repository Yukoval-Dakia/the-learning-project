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
import { type VerdictBreakerResult, checkAutoApplyBreaker } from './decide-breaker';

type DbLike = Db | Tx;

const COMPLETION_AUTOAPPLY_ACTION = 'experimental:completion_autoapply';
// 列表窗口：默认回看 24h（远长于撤销窗口——前端 autoAppliedState 用更短的 UNDO_WINDOW_MS
// 区分 live/consumed；这里只决定哪些卡进列表）。
export const AUTO_APPLIED_LIST_WINDOW_MS = 24 * 3_600_000;

export interface AutoAppliedRow {
  proposal_id: string;
  learning_item_id: string;
  /** 学习项标题（已删/缺失 → fallback 到 id）。 */
  title: string;
  /** apply 时刻（ISO）；前端据此 + now 判 live/consumed。 */
  applied_at: string;
  /** apply 时的熔断档位（'ok' | 'warned'）。 */
  level: string;
  /** 是否已被既有 retract 车道撤销（有对应 correct 事件）。 */
  reverted: boolean;
}

export interface AutoAppliedDigest {
  rows: AutoAppliedRow[];
  /** 当前熔断快照（A 块 meter/banner）。 */
  breaker: {
    tripped: boolean;
    level: string;
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
    .orderBy(desc(event.created_at), desc(event.id));

  const proposalIds = rows
    .map((r) => readProposalId(r.payload))
    .filter((id): id is string => id.length > 0);
  const revertedSet = await loadRetractedSet(db, proposalIds);

  const out: AutoAppliedRow[] = rows.map((r) => {
    const proposalId = readProposalId(r.payload);
    return {
      proposal_id: proposalId,
      learning_item_id: r.subjectId,
      title: r.title ?? r.subjectId,
      applied_at: r.createdAt.toISOString(),
      level: readLevel(r.payload),
      reverted: proposalId.length > 0 && revertedSet.has(proposalId),
    };
  });

  const breaker: VerdictBreakerResult = await checkAutoApplyBreaker(db, now);
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

function readProposalId(payload: unknown): string {
  const value = (payload as { proposal_id?: unknown } | null)?.proposal_id;
  return typeof value === 'string' ? value : '';
}

function readLevel(payload: unknown): string {
  const value = (payload as { level?: unknown } | null)?.level;
  return typeof value === 'string' ? value : 'ok';
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
