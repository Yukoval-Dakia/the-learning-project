// YUK-354 (A7 成效趋势面) — web client for the effectiveness-trend read model.
// Hits GET /api/observability/effectiveness-trend (registered in
// observability/manifest.ts), the per-KC / per-subject longitudinal mastery-delta
// surface (server/effectiveness-trend.ts — pure drizzle, zero write path).
//
// 横截面诊断看 calibration-maturity（「现在多准」）；本面看纵向 delta（「相比过去涨了吗」
// = 方向 + 置信）。前后端分离：读模型挂 observability 包，用户面落 Coach 复盘中枢。
//
// Types are kept STRICTLY in lock-step with the server response shape
// (EffectivenessTrendResponse / Series / SubjectTrendRollup / Aggregate in
// server/effectiveness-trend.ts + server/effectiveness-trend-summary.ts). The
// client re-declares (does NOT import the server module, which pulls @/db/client)
// so the field names/types here must mirror the server or the panel breaks.

import { type ApiOperationJsonResponse, apiOperationJson } from '@/ui/lib/api';

export type EffectivenessTrendResponse = ApiOperationJsonResponse<'getEffectivenessTrend'>;
export type EffectivenessTrendSeries = EffectivenessTrendResponse['series'][number];
export type EffectivenessTrendPoint = EffectivenessTrendSeries['points'][number];
export type EffectivenessTrendSummary = EffectivenessTrendSeries['trend'];
export type EffectivenessTrendAggregate = EffectivenessTrendResponse['aggregate'];
export type SubjectTrendRollup = EffectivenessTrendAggregate['by_subject'][number];
export type TrendDirection = EffectivenessTrendSummary['direction'];
export type TrendConfidence = EffectivenessTrendSummary['confidence'];

export const getEffectivenessTrend = () =>
  apiOperationJson('getEffectivenessTrend', {
    url: '/api/observability/effectiveness-trend',
    method: 'GET',
  });
