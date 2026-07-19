// YUK-706 (P0F/2) — thin route shell for the read-only TeachingBrief projection.

import { loadTeachingBrief } from '@/capabilities/shell/server/teaching-brief';
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await loadTeachingBrief(db));
  } catch (err) {
    return errorResponse(err);
  }
}
