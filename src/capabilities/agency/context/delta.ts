// Δ 段（读时现算，不落库）：稳态段 as_of 之后的增量 —— 作答 / 复习 / 录入 /
// 提议决策 / Steering 变化 / 对话发言，计数 + 最近 3 条确定性模板一句话；
// 再加今日到期数、连续错误、最近活动时间。
//
// 受限内容闸：增量只读 `eventAllowsDerivationSql()` 通过的行 —— crisis / 受限
// 用途事件（含危机倾诉、未授权照片派生）永远不会进启动段。模板一句话只渲染
// 动作类别与 outcome 词，不回放学习者自由文本。

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
const GOAL_ACTIONS = new Set([
  'experimental:genesis',
  'experimental:goal_status_update',
  'experimental:goal_scope_update',
]);

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

/**
 * Read the delta segment. `asOf` is the steady section's high-water; when there
 * is no steady row the segment falls back to the newest DELTA_SCAN_LIMIT events
 * and is labelled 近期 (no "since consolidation" claim).
 */
export async function readDeltaSection(
  db: DbLike,
  opts: { asOf: Date | null; now: Date },
): Promise<DeltaSection> {
  const toolCtx: ToolContext = {
    db: db as ToolContext['db'],
    taskRunId: 'learner-context-delta',
    callerActor: { kind: 'system', ref: 'learner-context' },
  };
  const [rows, due, streak, lastActivityAt] = await Promise.all([
    db
      .select({
        action: event.action,
        subject_kind: event.subject_kind,
        outcome: event.outcome,
        payload: event.payload,
        created_at: event.created_at,
      })
      .from(event)
      .where(
        and(
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
            eq(event.subject_kind, 'goal'),
          ),
          opts.asOf ? gt(event.created_at, opts.asOf) : undefined,
        ),
      )
      .orderBy(desc(event.created_at), desc(event.id))
      .limit(DELTA_SCAN_LIMIT),
    executeGetReviewDue(toolCtx, { limit: 50 }),
    loadLongestFailureStreak(db),
    loadLastLearnerEventAt(db),
  ]);

  const counts = { answers: 0, reviews: 0, captures: 0, decisions: 0, steering: 0, messages: 0 };
  for (const row of rows) {
    if (row.subject_kind === 'goal' && GOAL_ACTIONS.has(row.action)) {
      counts.steering += 1;
      continue;
    }
    if (row.action === ATTEMPT_ACTION || row.action === NATIVE_ATTEMPT_ACTION) counts.answers += 1;
    else if (row.action === REVIEW_ACTION) counts.reviews += 1;
    else if (row.action === RECORD_CAPTURE_ACTION) counts.captures += 1;
    else if (row.action === RATE_ACTION) counts.decisions += 1;
    else if (row.action === COPILOT_USER_ASK_ACTION) counts.messages += 1;
  }

  return {
    asOf: opts.asOf,
    counts,
    recent: rows.slice(0, 3).map((row) => ({ at: row.created_at, label: lineFor(row) })),
    reviewDueCount: due.queue_summary.total_returned,
    failureStreak: streak,
    lastActivityAt,
  };
}
