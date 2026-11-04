// Δ 段（读时现算，不落库）：稳态段 as_of 之后的增量 —— 作答 / 复习 / 录入 /
// 提议决策 / Steering 变化 / 对话发言，计数 + 最近 3 条确定性模板一句话；
// 再加今日到期数、连续错误、最近活动时间。
//
// 受限内容闸：增量只读 `eventAllowsDerivationSql()` 通过的行 —— crisis / 受限
// 用途事件（含危机倾诉、未授权照片派生）永远不会进启动段。模板一句话只渲染
// 动作类别与 outcome 词，不回放学习者自由文本；answer_only / crisis 回合的
// 发言也因此不计入「发言 N 次」。

import { and, desc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { COPILOT_USER_ASK_ACTION } from '@/kernel/events/copilot-actions';
import { eventAllowsDerivationSql } from '@/kernel/events/derivation-policy';
import {
  LEARNER_ANSWER_ACTIONS,
  loadLastLearnerEventAt,
  loadLongestFailureStreak,
} from '@/kernel/read-models/learner-activity';
import { executeGetReviewDue } from '@/kernel/read-models/review-due';
import type { ToolContext } from '@/kernel/tools/types';
import type { DeltaSection } from './types';

type DbLike = Db | Tx;

const DELTA_SCAN_LIMIT = 200;
const NATIVE_ATTEMPT_ACTION = 'experimental:assessment_attempt';
const RECORD_CAPTURE_ACTION = 'experimental:record_capture';
const REVIEW_ACTION = 'review';
const ATTEMPT_ACTION = 'attempt';
const RATE_ACTION = 'rate';
// 「目标调整」只认学习者本人的 status/scope 变更；建档时的 system genesis 事件不算。
const STEERING_ACTIONS = [
  'experimental:goal_status_update',
  'experimental:goal_scope_update',
] as const;
/** 「今日待复习」读数上限（端口 limit max(50)）；达到上限如实标「50+」。 */
const REVIEW_DUE_DISPLAY_CAP = 50;

const SHANGHAI_HOUR_MIN = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function shanghaiLabel(at: Date): string {
  return SHANGHAI_HOUR_MIN.format(at).replace(',', '');
}

function outcomeWord(outcome: string | null): string {
  return outcome === 'success'
    ? '对'
    : outcome === 'failure'
      ? '错'
      : outcome === 'partial'
        ? '半对'
        : '已记';
}

function rateWord(payload: unknown): string {
  const rating =
    payload && typeof payload === 'object' ? (payload as { rating?: unknown }).rating : undefined;
  return rating === 'accept'
    ? '提议被接受'
    : rating === 'dismiss'
      ? '提议被驳回'
      : typeof rating === 'string'
        ? `提议处置（${rating}）`
        : '提议有处置';
}

function lineFor(row: {
  action: string;
  subject_kind: string;
  outcome: string | null;
  payload: unknown;
}): string {
  if (row.action === ATTEMPT_ACTION || row.action === NATIVE_ATTEMPT_ACTION)
    return `作答·${outcomeWord(row.outcome)}`;
  if (row.action === REVIEW_ACTION) return `复习·${outcomeWord(row.outcome)}`;
  if (row.action === RECORD_CAPTURE_ACTION) return '录入学习记录';
  if (row.action === RATE_ACTION) return rateWord(row.payload);
  if (row.subject_kind === 'goal') return '目标调整';
  if (row.action === COPILOT_USER_ASK_ACTION) return '对话中发言';
  return '学习动态';
}

function deltaEventPredicate(asOf: Date) {
  return and(
    // Restricted-purpose events (crisis disclosures, consent-scoped
    // derivations) are excluded here, before any template sees them.
    eventAllowsDerivationSql(),
    or(
      and(
        eq(event.actor_kind, 'user'),
        inArray(event.action, [
          ...LEARNER_ANSWER_ACTIONS,
          RECORD_CAPTURE_ACTION,
          RATE_ACTION,
          COPILOT_USER_ASK_ACTION,
        ]),
      ),
      and(
        eq(event.subject_kind, 'goal'),
        eq(event.actor_kind, 'user'),
        inArray(event.action, [...STEERING_ACTIONS]),
      ),
    ),
    gt(event.created_at, asOf),
  );
}

/**
 * Read the delta segment: events after `asOf` (the consolidation high-water),
 * counted exactly by a grouped aggregate — the DELTA_SCAN_LIMIT rows only feed
 * the "最近 3 条" lines, never the numbers.
 */
export async function readDeltaSection(
  db: DbLike,
  opts: { asOf: Date; asOfBasis: 'dreaming' | 'lookback'; now: Date },
): Promise<DeltaSection> {
  const toolCtx: ToolContext = {
    db: db as ToolContext['db'],
    taskRunId: 'learner-context-delta',
    callerActor: { kind: 'system', ref: 'learner-context' },
  };
  const predicate = deltaEventPredicate(opts.asOf);
  const [rows, countRows, due, streak, lastActivityAt] = await Promise.all([
    db
      .select({
        action: event.action,
        subject_kind: event.subject_kind,
        outcome: event.outcome,
        payload: event.payload,
        created_at: event.created_at,
      })
      .from(event)
      .where(predicate)
      .orderBy(desc(event.created_at), desc(event.id))
      .limit(DELTA_SCAN_LIMIT),
    db
      .select({
        action: event.action,
        subject_kind: event.subject_kind,
        n: sql<number>`count(*)::int`,
      })
      .from(event)
      .where(predicate)
      .groupBy(event.action, event.subject_kind),
    executeGetReviewDue(toolCtx, { limit: REVIEW_DUE_DISPLAY_CAP }),
    loadLongestFailureStreak(db),
    loadLastLearnerEventAt(db),
  ]);

  const counts = { answers: 0, reviews: 0, captures: 0, decisions: 0, steering: 0, messages: 0 };
  for (const row of countRows) {
    if (row.subject_kind === 'goal') {
      counts.steering += row.n;
      continue;
    }
    if (row.action === ATTEMPT_ACTION || row.action === NATIVE_ATTEMPT_ACTION)
      counts.answers += row.n;
    else if (row.action === REVIEW_ACTION) counts.reviews += row.n;
    else if (row.action === RECORD_CAPTURE_ACTION) counts.captures += row.n;
    else if (row.action === RATE_ACTION) counts.decisions += row.n;
    else if (row.action === COPILOT_USER_ASK_ACTION) counts.messages += row.n;
  }

  return {
    asOf: opts.asOf,
    asOfBasis: opts.asOfBasis,
    counts,
    recent: rows.slice(0, 3).map((row) => ({ at: row.created_at, label: lineFor(row) })),
    reviewDueCount: due.queue_summary.total_returned,
    reviewDueOverCap: due.queue_summary.total_returned >= REVIEW_DUE_DISPLAY_CAP,
    failureStreak: streak,
    lastActivityAt,
  };
}
