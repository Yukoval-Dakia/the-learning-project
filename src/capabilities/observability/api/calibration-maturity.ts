// Read-only per-KC calibration firm-up surface. Auth is enforced upstream.
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

import { loadCalibrationMaturity } from '../server/calibration-maturity';

export async function GET(): Promise<Response> {
  try {
    const result = await loadCalibrationMaturity(db);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
