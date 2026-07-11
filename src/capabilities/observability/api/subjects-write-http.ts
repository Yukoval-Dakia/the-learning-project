// YUK-601 — 写面结果联合 → HTTP 映射（三壳共用）。
// 状态码合同（v3.2 §3 + UI design doc v1.1 §2.3）：
//   ok/noop → 200 · stale → 409 携 currentRevision（CAS 陈旧守卫，UI 以
//   currentRevision 在场分流 refetch）· conflict（撞名）→ 409 **不携**
//   currentRevision（UI 直出「名称已被占用」，不 refetch 重放）·
//   not_found → 404 · forbidden（general 锁定）→ 422 · invalid → 422（携
//   fan-out issues 时逐科回显）。
// currentRevision 走手写 Response.json（ApiError 承载不了附加字段——errors.ts
// 三字段形状；question-detail DELETE 409 同为先例）。

import type { ControlWriteResult } from '@/server/subjects/subject-control-write';
import type { TraitWriteResult } from '@/server/subjects/trait-write';

export function traitResultResponse(result: TraitWriteResult): Response {
  switch (result.kind) {
    case 'ok':
      return Response.json(
        { traitId: result.traitId, revision: result.revision, forked: result.forked },
        { status: 200 },
      );
    case 'noop':
      return Response.json(
        { traitId: result.traitId, revision: result.revision, noop: true },
        { status: 200 },
      );
    case 'stale':
      return Response.json(
        {
          error: 'stale_revision',
          message: `stale ${result.axis} revision`,
          currentRevision: result.currentRevision,
        },
        { status: 409 },
      );
    case 'not_found':
      return Response.json({ error: result.message }, { status: 404 });
    case 'forbidden':
      return Response.json({ error: result.message }, { status: 422 });
    case 'invalid':
      return Response.json(
        { error: result.message, ...(result.issues ? { issues: result.issues } : {}) },
        { status: 422 },
      );
  }
}

export function controlResultResponse(result: ControlWriteResult): Response {
  switch (result.kind) {
    case 'ok':
      return Response.json({ subjectRevision: result.subjectRevision }, { status: 200 });
    case 'noop':
      return Response.json(
        { subjectRevision: result.subjectRevision, noop: true },
        { status: 200 },
      );
    case 'stale':
      return Response.json(
        {
          error: 'stale_revision',
          message: 'stale subject revision',
          currentRevision: result.currentRevision,
        },
        { status: 409 },
      );
    case 'conflict':
      return Response.json({ error: result.message }, { status: 409 });
    case 'not_found':
      return Response.json({ error: result.message }, { status: 404 });
    case 'forbidden':
      return Response.json({ error: result.message }, { status: 422 });
    case 'invalid':
      return Response.json({ error: result.message }, { status: 422 });
  }
}

export async function readJsonBody(
  req: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, value: await req.json() };
  } catch {
    return {
      ok: false,
      response: Response.json({ error: 'request body must be valid JSON' }, { status: 400 }),
    };
  }
}
