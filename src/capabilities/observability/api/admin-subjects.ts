// M5-T4 (YUK-321) → YUK-601 (v3.2 §3.5) — GET /api/admin/subjects 管理枚举扩容：
// 全量 subject 含 general 与 retired（编辑器选科数据源），新增
// origin / retiredAt / isGeneralFallback / version(组合串) / subjectRevision
// （数字 CAS 轴——写面 expectedSubjectRevision 的首次提交值，owner review P1）。
// slim 红线（U7 R11）不变：绝不下发 promptFragments / noteTemplate /
// causeCategories 全血 profile；notation / capabilityCount 保留供既有列表页。
// 写操作仍必须走 /api/admin/*（RL5）。

import { db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { errorResponse } from '@/server/http/errors';
import { listAdminSubjects } from '@/server/subjects/admin-read';

export async function GET(): Promise<Response> {
  try {
    const subjects = await listAdminSubjects(db);
    return Response.json({ subjects });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function getSubject(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const subjects = await listAdminSubjects(db);
    const subject = subjects.find((candidate) => candidate.id === params.id);
    if (!subject) throw new ApiError('not_found', `subject ${params.id} not found`, 404);
    return Response.json(subject);
  } catch (err) {
    return errorResponse(err);
  }
}
