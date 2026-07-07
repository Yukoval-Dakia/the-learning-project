// YUK-577 — copilot 主动开口 nudge 读模型（GET /api/copilot/nudges 的纯 drizzle 读）。
// design: docs/design/2026-07-07-yuk577-proactive-triggers.md §3.2 / §3.6 / §3.7.
//
// 呈现资格 = 未过期 + 未处置（未 dismiss / 未 opened）+ **非 shadow**（Q6 surfacing gate：
// shadow 行是暗窗期证据，绝不出面，否则翻 flag 时倒出 backlog）+ 静默窗 backstop（§3.2 / Q7：
// 正练习中延迟 interrupt-sensitive kind）。best-effort 频控在写入侧（nudge-triggers），读侧只做
// 资格过滤。

import type { NudgeKindT } from '@/core/schema/event/nudge-events';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';
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

/**
 * 载入当前应呈现的 nudge（未过期 + 未处置 + 非 shadow + 静默窗 backstop）。
 * now 可注入以便测试。
 */
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
        // Q6 surfacing gate —— shadow 行绝不出面。
        sql`${event.payload}->>'shadow' = 'false'`,
        // 未过期。
        sql`(${event.payload}->>'expires_at')::timestamptz > ${now.toISOString()}::timestamptz`,
        // 未处置（既未 dismiss 也未 opened —— opened = 已展开对话，consumed，不重现）。
        sql`NOT EXISTS (
          SELECT 1 FROM ${event} c
          WHERE c.caused_by_event_id = ${event.id}
            AND c.action IN (${NUDGE_DISMISSED_ACTION}, ${NUDGE_OPENED_ACTION})
        )`,
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id));

  // 静默窗 backstop（§3.2 / Q7）：仅当此刻在练习中，才延迟 interrupt-sensitive kind
  // （练习结束后自然重现）。结果集极小，JS 过滤最直白。cut-1 ingestion 非 interrupt-sensitive。
  // NOTE: 这里 **重算当前** open-session 态，不消费 nudge.payload.in_active_session——backstop 关心
  // 的是「呈现此刻用户是否在答题」，而非 nudge 产生时的态（后者到读时已 stale）。因此 payload 里
  // 冻结的 in_active_session 是 **provenance-only 审计位**（「开口时是否在练习」），不驱动读时 defer。
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
