// YUK-600 (YUK-597 v3 §3.6) — POST /api/admin/subjects：thin-create 科目创建
// 唯一入口的 HTTP 面。业务全在 src/server/subjects/thin-create.ts（五步事务 +
// 幂等/撞名合同）；本层只做 body 解析与状态码映射：
//   created → 201 · replayed（幂等回放）→ 200 · invalid → 400 ·
//   name_conflict（custom↔builtin 撞名 / retired 占坑）→ 422。
// client 不参与 id/root/claim/绑定任何构造（YUK-602 onboarding UI 只调这里）。

import { db } from '@/db/client';
import { resourceResponse } from '@/kernel/http';
import { errorResponse } from '@/server/http/errors';
import { thinCreateSubject } from '@/server/subjects/thin-create';
import { z } from 'zod';

const Body = z.object({ displayName: z.string() });

export async function POST(req: Request): Promise<Response> {
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return Response.json({ error: 'request body must be valid JSON' }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ error: 'displayName (string) is required' }, { status: 400 });
    }
    const result = await thinCreateSubject(db, parsed.data.displayName);
    switch (result.kind) {
      case 'created':
        return resourceResponse(result.payload, {
          outcome: 'created',
          location: `/api/admin/subjects/${encodeURIComponent(result.payload.id)}`,
        });
      case 'replayed':
        return resourceResponse(result.payload, {
          outcome: 'existing',
          location: `/api/admin/subjects/${encodeURIComponent(result.payload.id)}`,
        });
      case 'invalid':
        return Response.json({ error: result.message }, { status: 400 });
      case 'name_conflict':
        return Response.json({ error: result.message }, { status: 422 });
    }
  } catch (err) {
    return errorResponse(err);
  }
}
