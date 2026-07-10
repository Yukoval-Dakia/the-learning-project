// YUK-598 (YUK-597 v2 §7 / v3 §2.3) — GET /api/subjects：learner 面 selectable
// 科目视图（SPA useSubjects() provider 的数据源）。
//
// 字段合同（逐字段裁，v2 §7）：{ id, displayName, renderConfig{font_family,
// notation, code_highlight}, causeCategories:[{id,label}], isGeneralFallback }。
// **明确不下发** promptFragments / noteTemplate / grounding / judgePolicy /
// sourceWhitelist（server-only AI 合同字段——subjects-list.unit.test 负测钉死）。
// **不复用** /api/admin/subjects：admin slim 面故意不带 causeCategories（R11 红线，
// 编辑器选科用），本面是错因下拉/渲染回退的数据源，混用破红线。
// isGeneralFallback = 派生布尔（v3 §2.3，hydrate 溯源缓存；general 不在 selectable
// 列表里，null 分支防御性存在）。

import { errorResponse } from '@/server/http/errors';
import { isGeneralFallbackFor } from '@/server/subjects/resolution-cache';
import { getDefaultSubjectRegistry } from '@/subjects/profile';

export async function GET(): Promise<Response> {
  try {
    const registry = getDefaultSubjectRegistry();
    const subjects = registry.getSelectableSubjectIds().flatMap((id) => {
      const profile = registry.get(id);
      if (!profile) return [];
      return [
        {
          id: profile.id,
          displayName: profile.displayName,
          renderConfig: {
            font_family: profile.renderConfig.font_family,
            notation: profile.renderConfig.notation,
            code_highlight: profile.renderConfig.code_highlight,
          },
          causeCategories: profile.causeCategories.map((c) => ({ id: c.id, label: c.label })),
          isGeneralFallback: isGeneralFallbackFor(profile.id),
        },
      ];
    });
    return Response.json({ subjects });
  } catch (err) {
    return errorResponse(err);
  }
}
