/**
 * Dev / bootstrap endpoint —— seed knowledge tree from `src/subjects/wenyan/curriculum.json`.
 *
 * 用途：首次部署到 NAS / 新 dev DB 时拉起一份基础知识图谱。**idempotent**：重复调
 * 只在缺失节点时 INSERT，已存在的不动。
 *
 * 调用：`curl -X POST -H "x-internal-token: $TOKEN" http://localhost:3000/api/_/seed`
 *
 * Phase 1 仅 single-domain（wenyan）；多 subject 切换路径见
 * `docs/superpowers/specs/2026-05-14-phase1c-design.md` D3 / out-of-scope。
 */
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { seedKnowledge } from '@/capabilities/knowledge/server/seed';

export async function POST(_req: Request) {
  try {
    const result = await seedKnowledge(db);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
