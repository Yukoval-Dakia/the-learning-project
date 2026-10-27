// copilot 主动开口 nudge 路由（薄路由 + 纯 drizzle 读/写）。
//
//   GET  /api/copilot/nudges              → 当前应呈现的 nudge（排 shadow/过期/已处置 + 静默窗 backstop）
//   POST /api/copilot/nudges/[id]/dismiss → 写 experimental:copilot_nudge_dismissed（× 关闭）
//   POST /api/copilot/nudges/[id]/opened  → 写 experimental:copilot_nudge_opened（点「看看」展开对话）
//
// dismiss/opened 是 KPI 分子/分母对面：dismiss_rate = dismissed/(opened+dismissed)，
// ignored = 过期无处置。三 action 独立聚合，绝不写 accept_suggestion、不碰 proposal KPI。
// /api/* token 校验由组合根中间件统一施加。

import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { dismissCopilotNudge, markCopilotNudgeOpened } from '../server/nudge-actions';
import { loadActiveNudges } from '../server/nudge-read';

export async function GET(): Promise<Response> {
  try {
    const nudges = await loadActiveNudges(db);
    return Response.json({ nudges });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function dismissPOST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    return Response.json(await dismissCopilotNudge(db, params));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function openedPOST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    return Response.json(await markCopilotNudgeOpened(db, params));
  } catch (err) {
    return errorResponse(err);
  }
}
