// A5 S2 (YUK-354) — FrontierRail read endpoint.
//
// GET /api/knowledge/frontier
//   → 200 { rows: FrontierRailItem[] } — the「下一步，你学得动这些」learnable-frontier
//          banner: live prereq-gated KCs (propose=false) + cold-start proposed-prereq
//          suggestions (propose=true, lowConf=true). Read-only; no write path.

import { loadFrontierRail } from '@/capabilities/knowledge/server/frontier-read';
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';

export async function GET(): Promise<Response> {
  try {
    const rows = await loadFrontierRail(db);
    return Response.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}
