// Presence-only write. Heartbeats no longer trigger note refine; editing
// presence feeds deferred-apply arbitration instead.

import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { requestEditingHeartbeat } from '../server/editing-request';

export async function POST(req: Request): Promise<Response> {
  try {
    return Response.json(await requestEditingHeartbeat(db, () => req.json()));
  } catch (err) {
    return errorResponse(err);
  }
}
