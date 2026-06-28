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
    // 冷启动信号（YUK-473 Slice 1）：active goal 数。TodayPage 在 0 时渲染冷开屏拦截。
    goal_count: number;
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

// ── /api/workbench/overnight-digest wire（YUK-520 A1 夜窗 digest，overnight-digest.db.test.ts
// 同形态；与 server overnight-digest-summary.ts 的 OvernightDigest 镜像） ──
export interface OvernightRunGroup {
  task_kind: string;
  count: number;
  status_breakdown: Record<string, number>;
}
export interface OvernightDigest {
  window: { from: string; to: string };
  // 空夜显式信号：false → 空夜态（与加载中/失败可区分，永不落 ColdStart）。
  has_overnight_activity: boolean;
  runs: OvernightRunGroup[];
  note_changes_count: number;
  new_proposals_count: number;
  new_conjectures_count: number;
  agent_notes_count: number;
}

export const getOvernightDigest = () => apiJson<OvernightDigest>('/api/workbench/overnight-digest');

export const getRecentAiChanges = () =>
  apiJson<{ window_hours: number; rows: AiChangeRow[] }>('/api/artifacts/ai-changes/recent');

// ── 热力分桶（设计稿 heat-cell data-lvl 0..5；真数据按事件量分段） ──
// 设计稿是假数据演示无分桶规则；阈值按「单日学习事件量」常识分段：
// 0 空 / 1-2 轻 / 3-5 中 / 6-9 高 / 10-15 峰 / ≥16 满。
// S3-fix (YUK-335): 扩到 0-5 用满设计 5 档 coral 渐档——满 coral(lvl 5) 是
// WeekHeat「全页 coral 叙事收束高潮」(audit §3.2)；原上限 4 让峰值色永不出现、
// .heat-cell[data-lvl="5"] 规则成死 CSS。≤15→4 保持既有边界断言不破，≥16 才点满。
export function heatLevel(count: number): 0 | 1 | 2 | 3 | 4 | 5 {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  if (count <= 15) return 4;
  return 5;
}
