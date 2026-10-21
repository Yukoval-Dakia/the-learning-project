// Read-only per-KC and per-subject effectiveness trends. Auth is enforced upstream.
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

import { loadEffectivenessTrend } from '../server/effectiveness-trend';

export async function GET(): Promise<Response> {
  try {
    const result = await loadEffectivenessTrend(db);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
