// GET /api/proposals/auto-applied route shell; the read model lives in
// @/server/proposals/auto-applied-read.

import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { getAutoAppliedDigest } from '@/server/proposals/auto-applied-read';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await getAutoAppliedDigest(db));
  } catch (err) {
    return errorResponse(err);
  }
}
