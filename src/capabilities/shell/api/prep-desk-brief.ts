// GET /api/prep-desk/brief route shell; the projection lives in
// ../server/teaching-brief.

import { loadTeachingBrief } from '@/capabilities/shell/server/teaching-brief';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await loadTeachingBrief(db));
  } catch (err) {
    return errorResponse(err);
  }
}
