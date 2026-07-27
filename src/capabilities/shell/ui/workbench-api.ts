// M4-T6 (YUK-319)：工作台 ui 数据层——/api/workbench/summary 聚合 wire +
// AI 改动近 24h 链（notes 包端点）。undo 链直接复用 notes 包 ui 数据层
// （跨包 ui import：workbench 是跨域壳层，plan 钦定复用而非复制）。

import { type ApiOperationJsonResponse, apiOperationJson } from '@/ui/lib/api';

export { type AiChangeRow, undoAiChange } from '@/capabilities/notes/ui-public';
import type { AiChangeRow } from '@/capabilities/notes/ui-public';

// ── /api/workbench/summary wire（workbench-summary.db.test.ts 同形态） ──
export type WorkbenchSummary = ApiOperationJsonResponse<'getWorkbenchSummary'>;

export const getWorkbenchSummary = () =>
  apiOperationJson('getWorkbenchSummary', {
    url: '/api/workbench/summary',
    method: 'GET',
  });

// ── /api/workbench/overnight-digest wire（YUK-520 A1 夜窗 digest，overnight-digest.db.test.ts
// 同形态；与 server overnight-digest-summary.ts 的 OvernightDigest 镜像） ──
export type OvernightDigest = ApiOperationJsonResponse<'getOvernightDigest'>;
export type OvernightRunGroup = OvernightDigest['runs'][number];
// YUK-580：某 task_kind 窗内 error 计数达阈值 → 静默失败标红条目（附最近 N 条 error_message 原串）。
export type DegradedKind = OvernightDigest['degraded_kinds'][number];

export const getOvernightDigest = () =>
  apiOperationJson('getOvernightDigest', {
    url: '/api/workbench/overnight-digest',
    method: 'GET',
  });

export const getRecentAiChanges = () =>
  apiOperationJson('listRecentArtifactAiChanges', {
    url: '/api/artifacts/ai-changes/recent',
    method: 'GET',
  });

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
