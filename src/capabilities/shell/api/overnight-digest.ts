// GET /api/workbench/overnight-digest route shell; the read model lives in
// ../server/overnight-digest.

import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { loadTodayOvernightDigest } from '@/server/today/overnight-digest';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await loadTodayOvernightDigest(db));
  } catch (err) {
    return errorResponse(err);
  }
}
