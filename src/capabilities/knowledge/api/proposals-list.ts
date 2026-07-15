// Phase 1c.1 Step 9.C — `/api/knowledge/proposals` rewritten over the event stream.
//
// YUK-42 keeps this legacy wire shape stable while moving projection logic into
// `src/server/proposals/inbox.ts`, the shared proposal reader for L5.

import { LegacyKnowledgeProposalQuerySchema } from '@/capabilities/knowledge/api/contracts';
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { type ProposalStatus, listLegacyKnowledgeProposals } from '@/server/proposals/inbox';

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const { status } = LegacyKnowledgeProposalQuerySchema.parse({
      status: url.searchParams.get('status') ?? undefined,
    });
    const rows = await listLegacyKnowledgeProposals(db, { status: status as ProposalStatus });
    return Response.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}
