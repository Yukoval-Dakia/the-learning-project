// YUK-577 — copilot 主动开口 nudge 前台 hook（读 GET /nudges + dismiss/opened 处置）。
// design: docs/design/2026-07-07-yuk577-proactive-triggers.md §4. 新文件，零撞车。

import { apiFetch, apiJson } from '@/ui/lib/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

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
  /** True while the initial GET is in flight (no cached data yet). */
  isLoading: boolean;
  /** True when the GET failed — consumers can distinguish from "no nudges". */
  isError: boolean;
  /** True while a dismiss/opened POST is in flight (disable buttons to avoid double-click). */
  isMutating: boolean;
  /** 「×」——写 dismissed event，该 kind 当日熔断（后端），读模型排除。 */
  dismiss: (id: string) => Promise<unknown>;
  /** 「看看」——写 opened event（KPI 分子），读模型排除（consumed）。 */
  markOpened: (id: string) => Promise<unknown>;
}

export function useCopilotNudges(): UseCopilotNudgesResult {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: NUDGES_KEY,
    queryFn: () => apiJson<{ nudges: CopilotNudge[] }>('/api/copilot/nudges'),
    // nudge 极稀（一次 ingestion / streak 才一条）；低频轮询即可，不给后端压力。
    refetchInterval: 60_000,
  });

  // useMutation gives isPending so the dock can disable 看看/× during the POST — the DB
  // companion unique index (0061) is the hard idempotency backstop; this is the UX soft gate.
  const dismissM = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/copilot/nudges/${id}/dismiss`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: NUDGES_KEY });
    },
  });
  const openedM = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/copilot/nudges/${id}/opened`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: NUDGES_KEY });
    },
  });

  return {
    nudges: q.data?.nudges ?? [],
    isLoading: q.isLoading,
    isError: q.isError,
    isMutating: dismissM.isPending || openedM.isPending,
    dismiss: dismissM.mutateAsync,
    markOpened: openedM.mutateAsync,
  };
}
