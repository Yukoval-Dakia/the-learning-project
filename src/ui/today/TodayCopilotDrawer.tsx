// Wave 5 / T-D3/B — /today drawer mount.
//
// Mounts <CopilotDrawer> with:
//   • Dwell hook controlling open state
//   • /api/today/copilot-summary feeding the summary slot
//   • A placeholder chat surface (T-D3/C wires the real chat endpoint)
//
// Intentionally light on chat UX — Wave 5/T-D3/C completes the chat side.

'use client';

import { apiJson } from '@/ui/lib/api';
import { useCopilotDwell } from '@/ui/lib/use-copilot-dwell';
import { Button } from '@/ui/primitives/Button';
import { CopilotDrawer } from '@/ui/primitives/CopilotDrawer';
import { useQuery } from '@tanstack/react-query';

interface DreamingPreviewRow {
  proposal_id: string;
  kind: string;
  brief: string;
  proposed_at: string;
}

interface CopilotSummary {
  daily_focus: string;
  plan_adjustments_count: number | null;
  dreaming_preview: DreamingPreviewRow[];
  pending_proposals_total: number;
  coach_last_run_at: string | null;
  dreaming_last_run_at: string | null;
}

export function TodayCopilotDrawer() {
  const { open, openDrawer, closeDrawer } = useCopilotDwell();
  const summaryQ = useQuery({
    queryKey: ['copilot-summary'],
    queryFn: () => apiJson<CopilotSummary>('/api/today/copilot-summary'),
    enabled: open,
    refetchInterval: open ? 60_000 : false,
  });

  return (
    <>
      <Button
        variant="quiet"
        size="sm"
        onClick={openDrawer}
        data-testid="copilot-drawer-trigger"
        icon="bot"
      >
        召唤 Copilot
      </Button>
      <CopilotDrawer
        open={open}
        onClose={closeDrawer}
        title="Copilot · 今日"
        summary={
          summaryQ.data ? (
            <div className="flex flex-col gap-[6px]">
              <p className="text-[13px] text-[var(--ink)] leading-[1.55]">
                {summaryQ.data.daily_focus}
              </p>
              {summaryQ.data.dreaming_preview.length > 0 ? (
                <ul className="list-disc list-inside text-[12.5px] text-[var(--ink-2)]">
                  {summaryQ.data.dreaming_preview.map((row) => (
                    <li key={row.proposal_id}>
                      <span className="font-mono text-[var(--ink-3)]">{row.kind}</span> {row.brief}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="text-[11.5px] text-[var(--ink-3)]">
                共 {summaryQ.data.pending_proposals_total} 条 pending 提案
                {summaryQ.data.coach_last_run_at
                  ? ` · Coach ${new Date(summaryQ.data.coach_last_run_at).toLocaleString()}`
                  : ''}
              </p>
            </div>
          ) : summaryQ.isLoading ? (
            <p className="text-[12.5px] text-[var(--ink-3)]">加载摘要…</p>
          ) : (
            <p className="text-[12.5px] text-[var(--ink-3)]">摘要暂不可用。</p>
          )
        }
      >
        <p className="text-[12.5px] text-[var(--ink-3)]">
          Wave 5 / T-D3/C 上线后这里会接入 chat。当前仅展示 Coach + Dreaming 摘要。
        </p>
      </CopilotDrawer>
    </>
  );
}
