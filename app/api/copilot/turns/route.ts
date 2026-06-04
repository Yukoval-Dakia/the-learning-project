// AF S3a / YUK-203 U3 — GET /api/copilot/turns?limit=20
//
// Replay-last-N: returns the recent Copilot conversation turns (ask/chip + reply
// pairs) oldest→newest so the drawer can prefill its message list on open. Token
// gated by middleware.ts (x-internal-token) like every other /api/* route.

import { db } from '@/db/client';
import { getRecentCopilotTurns } from '@/server/copilot/turns';
import { errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const raw = url.searchParams.get('limit');
    const limit = raw === null ? undefined : Number.parseInt(raw, 10);
    const turns = await getRecentCopilotTurns(db, { limit });
    return Response.json({ turns });
  } catch (err) {
    return errorResponse(err);
  }
}
