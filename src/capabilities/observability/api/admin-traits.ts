// YUK-601 (v3.2 §3.5) — GET /api/admin/traits?kind=<kind>：跨科 trait 目录
// （换绑选择器数据源——「化学借数学的 rubric」得先能列出候选）。kind 必填且
// 必须是六 kind 之一（400）。业务在 src/server/subjects/admin-read.ts。

import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { listAdminTraits } from '@/server/subjects/admin-read';
import { SUBJECT_TRAIT_KINDS, type SubjectTraitKind } from '@/subjects/trait-schemas';

export async function GET(req: Request): Promise<Response> {
  try {
    const kind = new URL(req.url).searchParams.get('kind');
    if (!kind || !(SUBJECT_TRAIT_KINDS as readonly string[]).includes(kind)) {
      return Response.json(
        { error: `kind query is required (one of: ${SUBJECT_TRAIT_KINDS.join(', ')})` },
        { status: 400 },
      );
    }
    const traits = await listAdminTraits(db, kind as SubjectTraitKind);
    return Response.json({ traits });
  } catch (err) {
    return errorResponse(err);
  }
}
