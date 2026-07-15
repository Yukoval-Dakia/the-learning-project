// YUK-577 — copilot 主动开口 nudge 路由（薄路由 + 纯 drizzle 读/写）。
// design: docs/design/2026-07-07-yuk577-proactive-triggers.md §3.5 / §3.6.
//
//   GET  /api/copilot/nudges              → 当前应呈现的 nudge（排 shadow/过期/已处置 + 静默窗 backstop）
//   POST /api/copilot/nudges/[id]/dismiss → 写 experimental:copilot_nudge_dismissed（× 关闭）
//   POST /api/copilot/nudges/[id]/opened  → 写 experimental:copilot_nudge_opened（点「看看」展开对话）
//
// dismiss/opened 是 YUK-178 分离的 KPI 分子/分母对面：dismiss_rate = dismissed/(opened+dismissed)，
// ignored = 过期无处置。三 action 独立聚合，绝不写 accept_suggestion、不碰 proposal KPI。
// /api/* token 校验由组合根中间件统一施加。

import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';
import { and, eq, sql } from 'drizzle-orm';
import { loadActiveNudges } from '../server/nudge-read';
import {
  NUDGE_ACTION,
  NUDGE_DISMISSED_ACTION,
  NUDGE_OPENED_ACTION,
} from '../server/nudge-triggers';
import { CopilotRouteIdParamsSchema } from './contracts';

export async function GET(): Promise<Response> {
  try {
    const nudges = await loadActiveNudges(db);
    return Response.json({ nudges });
  } catch (err) {
    return errorResponse(err);
  }
}

/** postgres.js surfaces unique violations as code '23505' (possibly wrapped); walk the cause chain. */
function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e !== null && typeof e === 'object'; depth++) {
    if ((e as { code?: unknown }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** 写一条 nudge companion event（dismiss / opened），先校验 nudge 存在防孤儿写。 */
async function writeNudgeCompanion(
  params: Record<string, string>,
  action: typeof NUDGE_DISMISSED_ACTION | typeof NUDGE_OPENED_ACTION,
): Promise<Response> {
  try {
    const { id: nudgeId } = CopilotRouteIdParamsSchema.parse(params);

    const exists = await db
      .select({ one: sql<number>`1` })
      .from(event)
      .where(and(eq(event.id, nudgeId), eq(event.action, NUDGE_ACTION)))
      .limit(1);
    if (exists.length === 0) {
      throw new ApiError('not_found', 'nudge not found', 404);
    }

    const companionId = newId();
    try {
      await writeEvent(db, {
        id: companionId,
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action,
        subject_kind: 'event',
        subject_id: nudgeId,
        outcome: null,
        payload: {},
        caused_by_event_id: nudgeId,
      });
    } catch (err) {
      // YUK-577 (Codex P2-2) — idempotency: the per-action partial unique index
      // (event_copilot_nudge_{opened,dismissed}_unique_idx ON event(caused_by_event_id)) rejects a
      // second companion for the same nudge (network retry / fast double-click). Treat 23505 as
      // already-recorded — return ok WITHOUT a new event so the opened/dismissed KPI is not
      // double-counted. (writeEvent's onConflictDoNothing only targets the PK; other unique
      // violations still throw here.)
      if (isUniqueViolation(err)) {
        return Response.json({ ok: true, deduped: true });
      }
      throw err;
    }
    return Response.json({ ok: true, event_id: companionId });
  } catch (err) {
    return errorResponse(err);
  }
}

export function dismissPOST(req: Request, params: Record<string, string>): Promise<Response> {
  return writeNudgeCompanion(params, NUDGE_DISMISSED_ACTION);
}

export function openedPOST(req: Request, params: Record<string, string>): Promise<Response> {
  return writeNudgeCompanion(params, NUDGE_OPENED_ACTION);
}
