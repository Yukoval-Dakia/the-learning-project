// Phase 1c.1 Step 9.C — `/api/knowledge/proposals` rewritten over the event stream.
//
// YUK-42 keeps this legacy wire shape stable while moving projection logic into
// `src/server/proposals/inbox.ts`, the shared proposal reader for L5.

import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { type ProposalStatus, listLegacyKnowledgeProposals } from '@/server/proposals/inbox';


export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const status = (url.searchParams.get('status') ?? 'pending') as ProposalStatus;
    const rows = await listLegacyKnowledgeProposals(db, { status });
    return Response.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}
