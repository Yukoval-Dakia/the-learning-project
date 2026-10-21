// Read-only judge agreement surface: gated headline, per-route and per-outcome
// strata, and recent runs. Auth is enforced upstream.
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { loadJudgeCalibrationStats } from '../server/judge-calibration';

export async function GET(): Promise<Response> {
  try {
    const result = await loadJudgeCalibrationStats(db);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
