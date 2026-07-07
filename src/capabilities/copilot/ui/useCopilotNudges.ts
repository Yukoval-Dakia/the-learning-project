// YUK-577 — copilot 主动开口 nudge 前台 hook（读 GET /nudges + dismiss/opened 处置）。
// design: docs/design/2026-07-07-yuk577-proactive-triggers.md §4. 新文件，零撞车。

import { apiFetch, apiJson } from '@/ui/lib/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

export interface CopilotNudge {
  id: string;
  kind: 'ingestion_complete' | 'kc_wrong_streak';
  headline: string;
  subject_kind: string;
  subject_id: string;
  created_at: string;
}

const NUDGES_KEY = ['copilot', 'nudges'] as const;

export interface UseCopilotNudgesResult {
  nudges: CopilotNudge[];
  /** 「×」——写 dismissed event，该 kind 当日熔断（后端），读模型排除。 */
  dismiss: (id: string) => Promise<void>;
  /** 「看看」——写 opened event（KPI 分子），读模型排除（consumed）。 */
  markOpened: (id: string) => Promise<void>;
}

export function useCopilotNudges(): UseCopilotNudgesResult {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: NUDGES_KEY,
    queryFn: () => apiJson<{ nudges: CopilotNudge[] }>('/api/copilot/nudges'),
    // nudge 极稀（一次 ingestion / streak 才一条）；低频轮询即可，不给后端压力。
    refetchInterval: 60_000,
  });

  const invalidate = useCallback(() => qc.invalidateQueries({ queryKey: NUDGES_KEY }), [qc]);

  const dismiss = useCallback(
    async (id: string) => {
      await apiFetch(`/api/copilot/nudges/${id}/dismiss`, { method: 'POST' });
      await invalidate();
    },
    [invalidate],
  );

  const markOpened = useCallback(
    async (id: string) => {
      await apiFetch(`/api/copilot/nudges/${id}/opened`, { method: 'POST' });
      await invalidate();
    },
    [invalidate],
  );

  return { nudges: q.data?.nudges ?? [], dismiss, markOpened };
}
