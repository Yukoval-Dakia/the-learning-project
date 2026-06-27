// YUK-495 S5 #41 (D2) — web client for the calibration-maturity read model.
// Hits GET /api/observability/calibration-maturity (registered in
// observability/manifest.ts), the per-KC mastery-calibration firm-up surface
// (server/calibration-maturity.ts — pure drizzle, zero write path).
//
// Types are kept STRICTLY in lock-step with the server response shape
// (CalibrationMaturityResponse / Row / Aggregate). The D2 maturity badge re-derives
// firm_count + median_theta_se from `rows` and reconciles bit-for-bit against
// `aggregate`; the field names/types here must mirror the server or that compare breaks.

import { apiJson } from '@/ui/lib/api';

export interface CalibrationMaturityRow {
  knowledge_id: string;
  name: string;
  /** mastery_state.evidence_count；从未 attempt 的 KC 为 0。 */
  evidence_count: number;
  /** thetaSe(theta_precision)——θ̂ 标准误，现算（不持久化）。无 mastery_state 行 → null。 */
  theta_se: number | null;
  /** 该 KC 关联题的 item_calibration 平均 confidence。无标定题 → null。 */
  confidence: number | null;
  /** 该 KC 关联题的代表性 track。无标定题 → null。 */
  track: string | null;
  cold_start: boolean;
}

export interface CalibrationMaturityAggregate {
  total_kcs: number;
  cold_start_count: number;
  firm_count: number;
  /** firm_count / total_kcs，0..1，保 4 位小数。total_kcs=0 → 0。 */
  pct_firm: number;
  /** 全图 theta_se 中位数（仅计有 mastery_state 行的 KC）。无任何行 → null。 */
  median_theta_se: number | null;
}

export interface CalibrationMaturityResponse {
  rows: CalibrationMaturityRow[];
  aggregate: CalibrationMaturityAggregate;
}

export const getCalibrationMaturity = () =>
  apiJson<CalibrationMaturityResponse>('/api/observability/calibration-maturity');
