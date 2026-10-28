// POST /api/teaching-sessions/[id]/accept-chip
// Writes `action:'accept_suggestion'` for a chip click. A corrective chip-accept
// is still a full event; only the KPI reader excludes it.

import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { requestTeachingChipAcceptance } from '../server/accept-teaching-chip';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    return Response.json(await requestTeachingChipAcceptance(db, params, () => req.json()));
  } catch (err) {
    return errorResponse(err);
  }
}
