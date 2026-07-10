// YUK-601 (v3.2 §3.5) — GET /api/admin/subjects/:id/traits：六绑定读面。
// { subjectRevision, bindings: [{ kind, traitId, origin, ownerSubjectId,
//   seedVersion, revision, effectiveRevision, degraded, payload, sharedBy }] }
// revision（live）与 effectiveRevision（实际采用）分列——降级中的 trait 在编辑器
// 可见「实际在用哪份」（v3.2）。业务在 src/server/subjects/admin-read.ts。

import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { getAdminSubjectTraits } from '@/server/subjects/admin-read';
import { z } from 'zod';

const ParamsSchema = z.object({ id: z.string().trim().min(1) });

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsed = ParamsSchema.safeParse(params);
    if (!parsed.success) {
      return Response.json({ error: 'subject id is required' }, { status: 400 });
    }
    const result = await getAdminSubjectTraits(db, parsed.data.id);
    if (result === null) {
      return Response.json({ error: `unknown subject "${parsed.data.id}"` }, { status: 404 });
    }
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
