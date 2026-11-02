// GET /api/proposals/auto-applied: historical cards and verdict-rate snapshot.

import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { getAutoAppliedDigest } from '../server/auto-applied-read';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await getAutoAppliedDigest(db));
  } catch (err) {
    return errorResponse(err);
  }
}
