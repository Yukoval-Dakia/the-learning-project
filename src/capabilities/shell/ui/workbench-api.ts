// M4-T6 (YUK-319)：工作台 ui 数据层——/api/workbench/summary 聚合 wire +
// AI 改动近 24h 链（notes 包端点）。undo 链直接复用 notes 包 ui 数据层
// （跨包 ui import：workbench 是跨域壳层，plan 钦定复用而非复制）。

import { apiJson } from '@/ui/lib/api';

export { type AiChangeRow, undoAiChange } from '@/capabilities/notes/ui/notes-api';
import type { AiChangeRow } from '@/capabilities/notes/ui/notes-api';

// ── /api/workbench/summary wire（workbench-summary.db.test.ts 同形态） ──
export interface WorkbenchSummary {
  proposals: { total: number; by_kind: Record<string, number>; status: string };
  kpi: {
    due_count: number;
    pending_attribution_count: number;
    knowledge_count: number;
  };
  active_sessions: Array<{
    id: string;
    status: string;
    summary_md: string | null;
    started_at: number; // epoch 秒
    ended_at: number | null;
    duration_ms: number | null;
    reviewed_count: number;
  }>;
  week_heat: Array<{ day: string; count: number }>;
}

export const getWorkbenchSummary = () => apiJson<WorkbenchSummary>('/api/workbench/summary');

export const getRecentAiChanges = () =>
  apiJson<{ window_hours: number; rows: AiChangeRow[] }>('/api/artifacts/ai-changes/recent');

// ── 热力分桶（设计稿 heat-cell data-lvl 0..4；真数据按事件量分段） ──
// 设计稿是假数据演示无分桶规则；阈值按「单日学习事件量」常识分段：
// 0 空 / 1-2 轻 / 3-5 中 / 6-9 高 / ≥10 峰。
export function heatLevel(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}
