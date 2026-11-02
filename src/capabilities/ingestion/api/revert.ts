// POST /api/ingestion/[id]/revert
//
// Reverts one auto-enrolled block to draft: retract event, archived record, and
// cleared import links, while keeping the question row. The [id] path is the
// session; the target block is in the body.
import { revertIngestionBlock } from '@/capabilities/ingestion/server/revert-auto-enroll';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const sessionId = params.id;
    const raw = await req.json().catch(() => null);
    const result = await revertIngestionBlock(db, sessionId, raw);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
