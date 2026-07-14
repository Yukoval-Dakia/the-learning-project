// YUK-598 (YUK-597 v2 §7) — useSubjects()：selectable 科目的 SPA provider。
//
// 数据源 = GET /api/subjects（shell capability；custom 科目经 YUK-599 水合自动
// 进列）。合同：
// - initialData = 编译期 builtin 投影（首帧不闪）+ initialDataUpdatedAt: 0
//   （立刻视为 stale → 挂载即拉真数据，custom 科目不用等 staleTime 窗口）；
// - staleTime 5min、**不轮询**——科目集合低频变化，写侧（thin-create，YUK-600/602）
//   mutation onSuccess 调 invalidateQueries(SUBJECTS_QUERY_KEY) 即时失效；
// - 断网/500：query 失败时 data 保持 initialData → chips/下拉退化到三 builtin，
//   与今日编译期行为逐位一致（诚实降级，非空白）。
// general 不进本 provider（selectable 视图结构性排除；渲染回退用
// DEFAULT_SLIM_SUBJECT_PROFILE，ui/lib/subject.ts）。

import { BUILTIN_IDS, subjectProfiles } from '@/subjects/profile';
import { apiJson } from '@/ui/lib/api';
import { useQuery } from '@tanstack/react-query';

export interface ApiSubject {
  id: string;
  displayName: string;
  aliases: string[];
  renderConfig: {
    font_family: string;
    notation: string | null;
    code_highlight: string | null;
  };
  causeCategories: Array<{ id: string; label: string }>;
  // 派生布尔（v3 §2.3）：科目仍整套沿用 general 默认配置（「通用模式」badge 数据源，
  // YUK-602 消费）。builtin 恒 false；general 不在列（防御性 null 类型保留）。
  isGeneralFallback: boolean | null;
  configurationStatus: 'configured' | 'general-fallback' | 'unconfigured';
}

export const SUBJECTS_QUERY_KEY = ['subjects'] as const;

// 编译期 builtin 投影（import 期快照——这里要的就是快照：断网兜底 + 首帧）。
function builtinProjection(): ApiSubject[] {
  return BUILTIN_IDS.flatMap((id) => {
    const p = subjectProfiles[id];
    if (!p) return [];
    return [
      {
        id: p.id,
        displayName: p.displayName,
        aliases: [],
        renderConfig: {
          font_family: p.renderConfig.font_family,
          notation: p.renderConfig.notation,
          code_highlight: p.renderConfig.code_highlight,
        },
        causeCategories: p.causeCategories.map((c) => ({ id: c.id, label: c.label })),
        isGeneralFallback: false,
        configurationStatus: 'configured',
      },
    ];
  });
}

export interface UseSubjectsResult {
  subjects: ApiSubject[];
  /** true = 仍在展示编译期投影且首次真数据未回（极短窗口；chips 无需 spinner）。 */
  isLoading: boolean;
  isError: boolean;
}

export function useSubjects(): UseSubjectsResult {
  const q = useQuery({
    queryKey: SUBJECTS_QUERY_KEY,
    queryFn: () => apiJson<{ subjects: ApiSubject[] }>('/api/subjects').then((r) => r.subjects),
    staleTime: 5 * 60_000,
    initialData: builtinProjection,
    initialDataUpdatedAt: 0, // 编译期投影立即视为 stale → 挂载即真拉
  });
  return {
    subjects: q.data ?? [],
    isLoading: q.isFetching && q.dataUpdatedAt === 0,
    isError: q.isError,
  };
}
