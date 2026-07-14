// YUK-601 (v3.2 §3.5) — GET /api/admin/traits/:id/journal：append-only 历史
// （rollback UI 数据源），倒序。不下发 payload（doc v1.1 §2.2：纯 revision 列表；
// diff 查看器 = owner 点名后的 follow-up）。业务在 src/server/subjects/admin-read.ts。

import { db } from '@/db/client';
import { collectionPayload } from '@/kernel/http';
import { errorResponse } from '@/server/http/errors';
import { getTraitJournalPage } from '@/server/subjects/admin-read';
import { z } from 'zod';

const ParamsSchema = z.object({ id: z.string().trim().min(1) });

export async function GET(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsed = ParamsSchema.safeParse(params);
    if (!parsed.success) {
      return Response.json({ error: 'trait id is required' }, { status: 400 });
    }
    const url = new URL(req.url);
    const rawLimit = url.searchParams.get('limit');
    const parsedLimit = rawLimit === null ? 100 : Number(rawLimit);
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      return Response.json({ error: 'limit must be a positive integer' }, { status: 400 });
    }
    const limit = Math.min(parsedLimit, 200);
    const page = await getTraitJournalPage(db, parsed.data.id, {
      limit,
      cursor: url.searchParams.get('cursor') ?? undefined,
    });
    if (page === null) {
      return Response.json({ error: `unknown trait "${parsed.data.id}"` }, { status: 404 });
    }
    return Response.json(
      collectionPayload(
        page.rows,
        { limit, next_cursor: page.next_cursor },
        {
          journal: page.rows,
          next_cursor: page.next_cursor,
        },
      ),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
