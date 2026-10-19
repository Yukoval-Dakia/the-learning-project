// Read model is write-free. Field names must match the server rows and aggregate,
// or the on-device compare reports a false drift.

import { type ApiOperationJsonResponse, apiOperationJson } from '@/ui/lib/api';

export type CalibrationMaturityResponse = ApiOperationJsonResponse<'getCalibrationMaturity'>;
export type CalibrationMaturityRow = CalibrationMaturityResponse['rows'][number];
export type CalibrationMaturityAggregate = CalibrationMaturityResponse['aggregate'];

export const getCalibrationMaturity = () =>
  apiOperationJson('getCalibrationMaturity', {
    url: '/api/observability/calibration-maturity',
    method: 'GET',
  });
