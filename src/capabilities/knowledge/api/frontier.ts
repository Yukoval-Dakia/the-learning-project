// Learnable-frontier banner: live gated KCs plus low-confidence cold-start
// suggestions. Read-only.

import { loadFrontierRail } from '@/capabilities/knowledge/server/frontier-read';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

export async function GET(): Promise<Response> {
  try {
    const rows = await loadFrontierRail(db);
    return Response.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}
