// YUK-567 slice-2 (教研团 Phase 0 / 备课台) — GET /api/prep-desk/probes 薄壳。
// 读模型在 ../server/prep-desk-probes（≤3 served-but-unanswered mind_probe，
// anti-guilt 无校准数字）。镜像 prep-desk-conjectures 的薄壳形状。

import { loadActiveProbes } from '@/capabilities/shell/server/prep-desk-probes';
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await loadActiveProbes(db));
  } catch (err) {
    return errorResponse(err);
  }
}
