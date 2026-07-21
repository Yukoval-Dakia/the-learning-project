// YUK-384 — GET /api/admin/hub-sync: durable hub-sync reconciler health snapshot
// for operators (status counts, generation lag, oldest dirty/invalid age,
// failures, latest ack/repair). Read-only; one aggregate query.

import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';

import { readHubSyncHealth } from '../server/hub-sync';

export async function GET(_req: Request): Promise<Response> {
  try {
    const health = await readHubSyncHealth(db);
    return Response.json(health);
  } catch (err) {
    return errorResponse(err);
  }
}
