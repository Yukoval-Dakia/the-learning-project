// A 档 auto-applied 卡的只读读模型（摘要页与收件箱共用）。
//
// 数据源：通用 `experimental:auto_apply` 锚（strength A 自动通道写入）+
// 历史 `experimental:completion_autoapply` 锚（YUK-525 后不再有新写入，仍可读）。
// 每条锚的 proposal_id 交给 kernel 的批量撤销分类器，一次得到「已撤销 / 可撤 /
// 被后续内容挡住」以及挡住的白话原因——页面不自己拼撤销条件，批量撤销入口也
// 用同一个分类器在事务内复核。
//
// 同时透传当前裁决速率快照（checkAutoApplyBreaker）供 A 块 meter/banner 渲染。
//
// 红线：只读 event 日志与各 owner 的只读状态，绝不触 θ̂ / p(L) / FSRS。

import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { event, learning_item } from '@/db/schema';
import {
  type AutoAppliedUndoDecision,
  classifyAutoAppliedUndoBatch,
} from '@/kernel/proposals/auto-applied-undo';
import { PROPOSAL_AUTOAPPLY_ACTION } from '@/kernel/proposals/auto-apply';
import {
  type VerdictBreakerStatus,
  checkAutoApplyBreaker,
} from '@/kernel/proposals/auto-apply-breaker';
import { COMPLETION_AUTOAPPLY_ACTION } from './completion-autoapply-actions';

type DbLike = Db | Tx;

// 列表窗口默认 24h，远长于撤销窗口；前端 autoAppliedState 用 UNDO_WINDOW_MS
// 区分 live/consumed，这里只决定哪些卡进列表。
export const AUTO_APPLIED_LIST_WINDOW_MS = 24 * 3_600_000;
// 行数上界仅防异常风暴（bug / 回填）一次拉爆列表，非业务上限。
export const AUTO_APPLIED_MAX_ROWS = 200;

/** Batch-undo state of one card; mirrors the batch retraction lane's verdict. */
export interface AutoAppliedUndoView {
  status: 'revertable' | 'blocked' | 'reverted';
  /** Stable machine code for the blocked state; null otherwise. */
  code: string | null;
  /** Learner-facing explanation; null when the card can be undone. */
  reason_md: string | null;
}

export interface AutoAppliedRow {
  proposal_id: string;
  /** Proposal kind that was auto-applied; drives the card's tag/icon. */
  kind: string;
  /** Historical wire field: learning_item id for completion, anchor subject otherwise. */
  learning_item_id: string;
  /** Card main line (anchor title; completion keeps the learning-item title). */
  title: string;
  /** Learner-facing one-liner recorded at apply time. */
  summary: string;
  /** apply 时刻（ISO）；前端据此 + now 判 live/consumed。 */
  applied_at: string;
  /** apply 时的熔断档位（'ok' | 'warned' | 'tripped'）。 */
  level: VerdictBreakerStatus;
  /** 是否已被既有 retract 车道撤销（最新更正状态为准）。 */
  reverted: boolean;
  /** 能否加入一键批量撤销；blocked 时带白话原因。 */
  undo: AutoAppliedUndoView;
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

const COMPLETION_SUMMARY = '自动判定为完成并已记录';

export async function getAutoAppliedDigest(
  db: DbLike,
  opts: { now?: Date; windowMs?: number; from?: Date; to?: Date } = {},
): Promise<AutoAppliedDigest> {
  const now = opts.now ?? new Date();
  const windowEnd = opts.to ?? now;
  const windowStart =
    opts.from ?? new Date(windowEnd.getTime() - (opts.windowMs ?? AUTO_APPLIED_LIST_WINDOW_MS));

  // breaker 与 rows 无依赖，并行取。
  const [rows, breaker] = await Promise.all([
    loadAutoAppliedRows(db, windowStart, windowEnd),
    checkAutoApplyBreaker(db, now),
  ]);

  const byProposal = new Map<string, AutoAppliedRow>();
  for (const r of rows) {
    const proposalId = readProposalId(r.payload);
    // 缺 proposal_id 的坏锚不进列表：UI 用 proposal id 做 key 和撤销入口。
    if (proposalId.length === 0 || byProposal.has(proposalId)) continue;
    const kind = readKind(r.action, r.payload);
    byProposal.set(proposalId, {
      proposal_id: proposalId,
      kind,
      learning_item_id: r.subjectId,
      title: readTitle(r),
      summary: readSummary(r.payload, kind),
      applied_at: r.createdAt.toISOString(),
      level: readLevel(r.payload),
      reverted: false,
      undo: { status: 'blocked', code: null, reason_md: null },
    });
  }

  const decisions = await classifyAutoAppliedUndoBatch(db, [...byProposal.keys()]);
  for (const [proposalId, row] of byProposal) {
    const decision = decisions.get(proposalId);
    if (!decision) continue;
    row.reverted = decision.status === 'reverted';
    row.undo = undoView(decision);
  }

  return {
    rows: [...byProposal.values()],
    breaker: {
      tripped: breaker.tripped,
      level: breaker.level,
      applied: breaker.applied,
      cap: breaker.cap,
      window: breaker.window,
    },
  };
}

function undoView(decision: AutoAppliedUndoDecision): AutoAppliedUndoView {
  if (decision.status === 'reverted') {
    return { status: 'reverted', code: null, reason_md: null };
  }
  if (decision.status === 'revertable') {
    return { status: 'revertable', code: null, reason_md: null };
  }
  // Internal read failures surface as blocked on the card: the page may offer no
  // action, and the reason still tells the learner why nothing happened.
  return {
    status: 'blocked',
    code: decision.code,
    reason_md: decision.reason_md,
  };
}

/** A 档列表行；撤销状态由 kernel 分类器统一给出。 */
async function loadAutoAppliedRows(db: DbLike, windowStart: Date, windowEnd: Date) {
  return db
    .select({
      action: event.action,
      subjectId: event.subject_id,
      payload: event.payload,
      createdAt: event.created_at,
      title: learning_item.title,
    })
    .from(event)
    .leftJoin(learning_item, eq(learning_item.id, event.subject_id))
    .where(
      and(
        inArray(event.action, [COMPLETION_AUTOAPPLY_ACTION, PROPOSAL_AUTOAPPLY_ACTION]),
        gte(event.created_at, windowStart),
        lte(event.created_at, windowEnd),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(AUTO_APPLIED_MAX_ROWS);
}

function readProposalId(payload: unknown): string {
  const value = (payload as { proposal_id?: unknown } | null)?.proposal_id;
  return typeof value === 'string' ? value : '';
}

function readString(payload: unknown, key: string): string {
  const value = (payload as Record<string, unknown> | null)?.[key];
  return typeof value === 'string' ? value : '';
}

function readKind(action: string, payload: unknown): string {
  if (action === PROPOSAL_AUTOAPPLY_ACTION) {
    const kind = readString(payload, 'kind');
    if (kind.length > 0) return kind;
  }
  // Historical completion anchors predate the kind field.
  return 'completion';
}

function readTitle(row: {
  title: string | null;
  subjectId: string;
  action: string;
  payload: unknown;
}): string {
  if (row.action === PROPOSAL_AUTOAPPLY_ACTION) {
    const anchorTitle = readString(row.payload, 'title');
    if (anchorTitle.length > 0) return anchorTitle;
  }
  return row.title ?? row.subjectId;
}

function readSummary(payload: unknown, kind: string): string {
  const summary = readString(payload, 'summary');
  if (summary.length > 0) return summary;
  return kind === 'completion' ? COMPLETION_SUMMARY : '';
}

// payload.level 只接受三档；非法/缺失落 'ok'。
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
