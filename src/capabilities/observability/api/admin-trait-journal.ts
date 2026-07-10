// YUK-601 (v3.2 §3.5) — GET /api/admin/traits/:id/journal：append-only 历史
// （rollback UI 数据源），倒序。不下发 payload（doc v1.1 §2.2：纯 revision 列表；
// diff 查看器 = owner 点名后的 follow-up）。业务在 src/server/subjects/admin-read.ts。

import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { getTraitJournal } from '@/server/subjects/admin-read';
import { z } from 'zod';

const ParamsSchema = z.object({ id: z.string().trim().min(1) });

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsed = ParamsSchema.safeParse(params);
    if (!parsed.success) {
      return Response.json({ error: 'trait id is required' }, { status: 400 });
    }
    const journal = await getTraitJournal(db, parsed.data.id);
    if (journal === null) {
      return Response.json({ error: `unknown trait "${parsed.data.id}"` }, { status: 404 });
    }
    return Response.json({ journal });
  } catch (err) {
    return errorResponse(err);
  }
}
