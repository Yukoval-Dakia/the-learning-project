// YUK-495 S5 #41 (D2) — web client for the calibration-maturity read model.
// Hits GET /api/observability/calibration-maturity (registered in
// observability/manifest.ts), the per-KC mastery-calibration firm-up surface
// (server/calibration-maturity.ts — pure drizzle, zero write path).
//
// Types are kept STRICTLY in lock-step with the server response shape
// (CalibrationMaturityResponse / Row / Aggregate). The D2 maturity badge re-derives
// firm_count + median_theta_se from `rows` and reconciles bit-for-bit against
// `aggregate`; the field names/types here must mirror the server or that compare breaks.

import { type ApiOperationJsonResponse, apiOperationJson } from '@/ui/lib/api';

export type CalibrationMaturityResponse = ApiOperationJsonResponse<'getCalibrationMaturity'>;
export type CalibrationMaturityRow = CalibrationMaturityResponse['rows'][number];
export type CalibrationMaturityAggregate = CalibrationMaturityResponse['aggregate'];

export const getCalibrationMaturity = () =>
  apiOperationJson('getCalibrationMaturity', {
    url: '/api/observability/calibration-maturity',
    method: 'GET',
  });
