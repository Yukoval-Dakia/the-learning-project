// YUK-602（design doc docs/design/2026-07-11-yuk601-602-ui-design.md §1.1，APPROVED
// v1.1）— thin-create mutation hook。POST /api/admin/subjects；201（created）与
// 200（幂等回放）都 resolve 到 payload——UI 零去重逻辑，重试安全性由服务端幂等回放
// 兜底（YUK-602 单据红线：client 不参与 id/root/claim/绑定任何构造）。
// onSuccess invalidate SUBJECTS_QUERY_KEY → chips 经 YUK-598 provider 通路即时出现。

import { ApiAuthError, ApiError, apiJson } from '@/ui/lib/api';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SUBJECTS_QUERY_KEY } from './useSubjects';

// thin-create 201/200 payload（v2 §7 合同 + v3 §3.6：isGeneralFallback 派生恒 true）。
export interface CreatedSubject {
  id: string;
  displayName: string;
  isGeneralFallback: boolean;
  revision: number;
  seedRootId: string;
}

export function createSubject(displayName: string): Promise<CreatedSubject> {
  return apiJson<CreatedSubject>('/api/admin/subjects', {
    method: 'POST',
    body: JSON.stringify({ displayName }),
  });
}

// 错误 → 用户可读文案（doc §1.4 错误合同）：
//   422（撞名等）→ 直出 server 文案——admin-subjects-create 把人类可读 message 放在
//     body.error，apiFetch 将其存进 ApiError.code（body.message 不存在时 message
//     只剩状态行），所以这里读 code。server 文案即错误合同，UI 不改写。
//   400 → 「科目名无效」；token 缺失/失效 → ApiAuthError 原文；
//   其余（网络/5xx）→ 可重试提示（API 幂等，直接重试安全）。
export function createSubjectErrorText(err: unknown): string {
  if (err instanceof ApiAuthError) return err.message;
  if (err instanceof ApiError) {
    if (err.status === 422) return err.code ?? err.message;
    if (err.status === 400) return '科目名无效';
  }
  return '网络错误，可直接重试';
}

export function useCreateSubject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createSubject,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SUBJECTS_QUERY_KEY });
    },
  });
}
