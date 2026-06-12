// M5-T4 (YUK-321) — GET /api/admin/subjects（新建：旧页是纯 RSC 直读 registry，
// SPA 化需要 API 面）。slim 投影沿 U7 的 R11 红线：id / displayName / version /
// notation / capabilityCount，绝不下发 promptFragments / noteTemplate /
// causeCategories 全血 profile。写操作未来也必须走 /api/admin/*（RL5）。

import { errorResponse } from '@/server/http/errors';
import { getDefaultSubjectRegistry } from '@/subjects/profile';

export async function GET(): Promise<Response> {
  try {
    const subjects = getDefaultSubjectRegistry()
      .listProfiles()
      .map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        version: profile.version,
        notation: profile.renderConfig.notation,
        capabilityCount: profile.judgeCapabilities.length,
      }));
    return Response.json({ subjects });
  } catch (err) {
    return errorResponse(err);
  }
}
