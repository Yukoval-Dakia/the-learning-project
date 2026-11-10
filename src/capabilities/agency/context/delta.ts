// Δ 段（读时现算，不落库）：稳态段 as_of 之后的增量 —— 作答 / 复习 / 录入 /
// 提议决策 / Steering 变化 / 对话发言，计数 + 最近 3 条确定性模板一句话；
// 再加今日到期数、连续错误、最近活动时间。
//
// 受限内容闸：增量只读 `eventAllowsDerivationSql()` 通过的行 —— crisis / 受限
// 用途事件（含危机倾诉、未授权照片派生）永远不会进启动段。模板一句话只渲染
// 动作类别与 outcome 词，不回放学习者自由文本；answer_only / crisis 回合的
// 发言也因此不计入「发言 N 次」。

import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event, knowledge } from '@/db/schema';
import { COPILOT_USER_ASK_ACTION } from '@/kernel/events/copilot-actions';
import { allowedEventIds } from '@/kernel/events/derivation-policy';
import { readAgentNotes } from '@/kernel/read-models/agent-note-hints';
import { excerpt } from '@/kernel/read-models/extraction-summary';
import {
  LEARNER_ANSWER_ACTIONS,
  loadLastLearnerEventAt,
  loadLongestFailureStreak,
} from '@/kernel/read-models/learner-activity';
import { learnerVisibleKnowledgeIds } from '@/kernel/read-models/learner-knowledge-visibility';
import { SYNTHETIC_SUBJECT_ROOT_RE } from '@/kernel/read-models/placement-scope';
import { executeGetReviewDue } from '@/kernel/read-models/review-due';
import { allowedQuestionIds } from '@/kernel/read-models/usage-policy';
import type { ToolContext } from '@/kernel/tools/types';
import type { DeltaSection, DueItemLine } from './types';

type DbLike = Db | Tx;

export const DELTA_SCAN_LIMIT = 200;
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
/** 启动段只带前几道到期题：够回答「今天做什么」，不代替复习页。 */
const DUE_ITEM_DETAIL_MAX = 3;
/** 明细字段再压到单行宽度，防长题干/长知识链吃掉启动段预算。 */
const DUE_STEM_EXCERPT_MAX = 36;
const DUE_KNOWLEDGE_NAME_MAX = 2;

const SHANGHAI_HOUR_MIN = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function shanghaiLabel(at: Date): string {
  // en-GB 的 MM/DD 会被读成 4 月 11 日；显式拼 MM-DD 消除歧义。
  const parts = Object.fromEntries(
    SHANGHAI_HOUR_MIN.formatToParts(at).map((p) => [p.type, p.value]),
  );
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
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
 * limited to the newest DELTA_SCAN_LIMIT candidate events before purpose checks.
 * The rendered window label makes capped counts explicit.
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
  const [candidates, due, streak, lastActivityAt, mixNotes] = await Promise.all([
    db
      .select({
        id: event.id,
        action: event.action,
        subject_kind: event.subject_kind,
        outcome: event.outcome,
        payload: event.payload,
        created_at: event.created_at,
      })
      .from(event)
      .where(predicate)
      .orderBy(desc(event.created_at), desc(event.id))
      .limit(DELTA_SCAN_LIMIT + 1),
    executeGetReviewDue(toolCtx, { limit: REVIEW_DUE_DISPLAY_CAP }),
    loadLongestFailureStreak(db),
    loadLastLearnerEventAt(db),
    readAgentNotes(db, { for_agent: 'copilot', now: opts.now, limit: 20 }),
  ]);

  const window = candidates.slice(0, DELTA_SCAN_LIMIT);
  const allowed = await allowedEventIds(
    db,
    window.map((row) => row.id),
  );
  const rows = window.filter((row) => allowed.has(row.id));
  const countRows = rows.map((row) => ({ ...row, n: 1 }));
  const purposeAllowed = await allowedQuestionIds(
    db,
    due.rows.map((row) => row.question_id),
  );
  const sourceAllowed = (questionId: string) => purposeAllowed.has(questionId);

  // 到期队列前几条明细：题干摘要 + 知识点显示名（学习者可见 id、非 seed 结构锚、未归档节点）。
  const dueItemRows = due.rows
    .filter((row) => sourceAllowed(row.question_id))
    .slice(0, DUE_ITEM_DETAIL_MAX);
  const dueKnowledgeIds = learnerVisibleKnowledgeIds(
    dueItemRows
      .flatMap((row) => row.knowledge_ids)
      .filter((id) => !SYNTHETIC_SUBJECT_ROOT_RE.test(id)),
  );
  const dueKnowledgeNameById =
    dueKnowledgeIds.length > 0
      ? new Map(
          (
            await db
              .select({ id: knowledge.id, name: knowledge.name })
              .from(knowledge)
              .where(and(inArray(knowledge.id, dueKnowledgeIds), isNull(knowledge.archived_at)))
          ).map((row) => [row.id, row.name] as const),
        )
      : new Map<string, string>();
  const dueItems: DueItemLine[] = dueItemRows
    .map((row) => ({
      stem: excerpt(row.prompt_excerpt, DUE_STEM_EXCERPT_MAX),
      knowledgeNames: row.knowledge_ids
        .map((id) => dueKnowledgeNameById.get(id))
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
        .slice(0, DUE_KNOWLEDGE_NAME_MAX),
    }))
    .filter((item) => item.stem.length > 0);

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
    countsWindowLimited: candidates.length > DELTA_SCAN_LIMIT,
    recent: rows.slice(0, 3).map((row) => ({ at: row.created_at, label: lineFor(row) })),
    reviewDueCount: due.queue_summary.total_returned,
    reviewDueOverCap: due.queue_summary.total_returned >= REVIEW_DUE_DISPLAY_CAP,
    dueItems,
    failureStreak: streak,
    lastActivityAt,
    mixNote:
      mixNotes.find((note) => note.signal_kind === 'practice_stream_mix')?.summary_md ?? null,
  };
}
