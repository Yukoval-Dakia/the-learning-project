// Operator health snapshot for hub sync: status counts, lag, stale ages, failures
// and the latest ack/repair. Read-only; one aggregate query.

import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

import { readHubSyncHealth } from '../server/hub-sync';

export async function GET(_req: Request): Promise<Response> {
  try {
    const health = await readHubSyncHealth(db);
    return Response.json(health);
  } catch (err) {
    return errorResponse(err);
  }
}
