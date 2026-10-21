// Copilot 主动开口 nudge 读模型（GET /api/copilot/nudges 的纯 drizzle 读）。
//
// 呈现资格 = 未过期 + 未处置（未 dismiss / 未 opened）+ 非 shadow（shadow 行是证据，绝不出面）
// + 静默窗 backstop（正练习中延迟 interrupt-sensitive kind）。频控在写入侧，读侧只做资格过滤。

import { and, desc, eq, sql } from 'drizzle-orm';
import type { NudgeKindT } from '@/core/schema/event/nudge-events';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import {
  INTERRUPT_SENSITIVE_KINDS,
  NUDGE_ACTION,
  NUDGE_DISMISSED_ACTION,
  NUDGE_OPENED_ACTION,
  isInActivePracticeSession,
} from './nudge-triggers';

/** GET /nudges 返回的单条 nudge（UI badge 只需 id + kind + headline）。 */
export interface NudgeDTO {
  id: string;
  kind: NudgeKindT;
  headline: string;
  subject_kind: string;
  subject_id: string;
  created_at: string;
}

/** 载入当前应呈现的 nudge。now 可注入以便测试。 */
export async function loadActiveNudges(db: Db, now: Date = new Date()): Promise<NudgeDTO[]> {
  const rows = await db
    .select({
      id: event.id,
      subject_kind: event.subject_kind,
      subject_id: event.subject_id,
      payload: event.payload,
      created_at: event.created_at,
    })
    .from(event)
    .where(
      and(
        eq(event.action, NUDGE_ACTION),
        // shadow 行绝不出面。
        sql`${event.payload}->>'shadow' = 'false'`,
        sql`(${event.payload}->>'expires_at')::timestamptz > ${now.toISOString()}::timestamptz`,
        // 未处置：opened = 已展开对话，consumed，不重现。
        sql`NOT EXISTS (
          SELECT 1 FROM ${event} c
          WHERE c.caused_by_event_id = ${event.id}
            AND c.action IN (${NUDGE_DISMISSED_ACTION}, ${NUDGE_OPENED_ACTION})
        )`,
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id));

  // 静默窗 backstop：仅当此刻在练习中，才延迟 interrupt-sensitive kind（练习结束后自然重现）。
  // 重算当前 open-session 态，不消费 nudge.payload.in_active_session——后者是开口时的
  // provenance-only 审计位，到读时已 stale（不驱动读时 defer）。结果集极小，JS 过滤最直白。
  const inActive = await isInActivePracticeSession(db);

  return rows
    .map((r) => {
      const p = r.payload as { kind: NudgeKindT; headline: string };
      return {
        id: r.id,
        kind: p.kind,
        headline: p.headline,
        subject_kind: r.subject_kind,
        subject_id: r.subject_id,
        created_at: r.created_at.toISOString(),
      };
    })
    .filter((n) => !(inActive && INTERRUPT_SENSITIVE_KINDS.has(n.kind)));
}
