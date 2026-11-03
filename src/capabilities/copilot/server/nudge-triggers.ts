// Copilot 主动开口触发线：确定性判定器（零 LLM）。
//
// evaluateNudgeTrigger 是纯 db-in / decision-out——只读，不写。写 nudge event 与 23505 幂等收口
// 由 handler（copilot_nudge_evaluate.ts）做；判定只做事件模式匹配 + 计数查询。

import { type AnyColumn, type SQL, and, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { NudgePayloadT } from '@/core/schema/event/nudge-events';
import type { Db } from '@/db/client';
import { event, question_block, source_document } from '@/db/schema';
import { isInActivePracticeSession } from '@/kernel/read-models/practice-session-open';
import type { NudgeConfig } from './nudge-config';

export const NUDGE_ACTION = 'experimental:copilot_nudge';
export const NUDGE_DISMISSED_ACTION = 'experimental:copilot_nudge_dismissed';
export const NUDGE_OPENED_ACTION = 'experimental:copilot_nudge_opened';

/** boss.send payload：只带定位 id，判定事实由 handler 从 event 表回读。 */
export type NudgeEvaluateInput = { kind: 'ingestion_complete'; session_id: string };

export type NudgeDecisionReason =
  | 'no_extract_event' // post-commit 后不应发生，防御
  | 'no_blocks' // 提取 0 片段——不为空材料开口
  | 'already_nudged' // perf 层；unique index 才是正确性保证
  | 'daily_cap'
  | 'dismiss_fused'; // 当日 dismiss 过同 kind → 该 kind 当日不再发

/** fire=true 时交给 handler 写入的 nudge event。 */
export interface NudgeToWrite {
  subject_kind: 'learning_session';
  subject_id: string;
  caused_by_event_id: string;
  payload: NudgePayloadT;
}

export type NudgeDecision =
  | { fire: false; reason: NudgeDecisionReason }
  | { fire: true; event: NudgeToWrite };

/** Asia/Shanghai（固定 UTC+8，无 DST）当日谓词：col 的 Shanghai 日 === now 的 Shanghai 日。 */
function sameShanghaiDay(col: AnyColumn | SQL, now: Date): SQL {
  return sql`(${col} AT TIME ZONE 'Asia/Shanghai')::date = (${now.toISOString()}::timestamptz AT TIME ZONE 'Asia/Shanghai')::date`;
}

export async function evaluateNudgeTrigger(
  db: Db,
  input: NudgeEvaluateInput,
  config: NudgeConfig,
  now: Date = new Date(),
): Promise<NudgeDecision> {
  // 触发源 = 该 session 的域 extract 事件；subject_id = source_document_id，用于取标题。
  const extractRows = await db
    .select({ id: event.id, subjectId: event.subject_id })
    .from(event)
    .where(and(eq(event.session_id, input.session_id), eq(event.action, 'extract')))
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(1);
  const extractEvent = extractRows[0];
  if (!extractEvent) return { fire: false, reason: 'no_extract_event' };

  // perf 层查重；unique index 是正确性保证，handler 捕 23505。
  const dup = await db
    .select({ one: sql<number>`1` })
    .from(event)
    .where(and(eq(event.action, NUDGE_ACTION), eq(event.caused_by_event_id, extractEvent.id)))
    .limit(1);
  if (dup.length > 0) return { fire: false, reason: 'already_nudged' };

  // 数 question_block 行（提取事实），非「收进 N 题」。
  const countRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(question_block)
    .where(eq(question_block.ingestion_session_id, input.session_id));
  const blockCount = Number(countRows[0]?.n ?? 0);
  if (blockCount === 0) return { fire: false, reason: 'no_blocks' };

  const shadow = !config.enabled;

  // surfacing 护栏只在 enabled（写可见 nudge）时施加：shadow 期跳过 dailyMax / dismiss-fuse，
  // 以便观测真实触发率；COUNT 也只数非 shadow 行。
  if (!shadow) {
    // 每日上限只数当日可见（非 shadow）nudge。
    const capRows = await db
      .select({ n: sql<number>`count(*)` })
      .from(event)
      .where(
        and(
          eq(event.action, NUDGE_ACTION),
          sql`${event.payload}->>'shadow' = 'false'`,
          sameShanghaiDay(event.created_at, now),
        ),
      );
    if (Number(capRows[0]?.n ?? 0) >= config.dailyMax) return { fire: false, reason: 'daily_cap' };

    // dismiss 熔断（kind-wide）：当日 dismiss 过 ingestion_complete → 该 kind 当日不再发。
    const dismissed = alias(event, 'nudge_dismissed');
    const nudge = alias(event, 'nudge_src');
    const fusedRows = await db
      .select({ one: sql<number>`1` })
      .from(dismissed)
      .innerJoin(nudge, eq(nudge.id, dismissed.caused_by_event_id))
      .where(
        and(
          eq(dismissed.action, NUDGE_DISMISSED_ACTION),
          sameShanghaiDay(dismissed.created_at, now),
          sql`${nudge.payload}->>'kind' = 'ingestion_complete'`,
        ),
      )
      .limit(1);
    if (fusedRows.length > 0) return { fire: false, reason: 'dismiss_fused' };
  }

  // 静默窗 backstop 观测位：冻结进 payload 作为开口时的审计位；读侧另行重算当前态。
  const inActiveSession = await isInActivePracticeSession(db);

  // session 显示名 = source_document.title（可空；learning_session 无 name 列）；空则降级。
  let title: string | null = null;
  if (extractEvent.subjectId) {
    const docRows = await db
      .select({ title: source_document.title })
      .from(source_document)
      .where(eq(source_document.id, extractEvent.subjectId))
      .limit(1);
    const t = docRows[0]?.title?.trim();
    title = t ? t : null;
  }

  const expiresAt = new Date(now.getTime() + config.expiresHours * 3_600_000).toISOString();
  const payload: NudgePayloadT = {
    kind: 'ingestion_complete',
    // 措辞断言 extraction 产出（不随 auto-enroll flag 漂移），绝不「收进 N 题」。
    headline: title
      ? `我处理完《${title}》，提取到 ${blockCount} 个题目片段`
      : `我处理完你上传的材料，提取到 ${blockCount} 个题目片段`,
    expires_at: expiresAt,
    shadow,
    in_active_session: inActiveSession,
    evidence: { session_id: input.session_id, block_count: blockCount, title },
  };

  return {
    fire: true,
    event: {
      subject_kind: 'learning_session',
      subject_id: input.session_id,
      caused_by_event_id: extractEvent.id,
      payload,
    },
  };
}
