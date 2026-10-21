// GET /api/prep-desk/probes route shell; the read model lives in
// ../server/prep-desk-probes.

import { loadActiveProbes } from '@/capabilities/shell/server/prep-desk-probes';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await loadActiveProbes(db));
  } catch (err) {
    return errorResponse(err);
  }
}
