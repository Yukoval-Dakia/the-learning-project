// M4-T5 (YUK-319)：旧 app/api/today/ai-changes GET 等价平移（since=24h +
// limit 25 + window_hours wire 不变）。旧路由的批量 undo POST 不平移——新 UI
// 撤销走 M3 per-event 链（POST /api/artifacts/[id]/ai-changes/[eventId]/undo），
// 批量端点随旧 today 页一起在 T7 拆除。

import { listNoteRefineChanges } from '@/capabilities/notes/server/note-refine-apply';
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';

export async function GET(): Promise<Response> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const rows = await listNoteRefineChanges(db, { since, limit: 25 });
    return Response.json({ window_hours: 24, rows });
  } catch (err) {
    return errorResponse(err);
  }
}
