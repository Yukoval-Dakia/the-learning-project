// Legacy knowledge proposal list. The wire shape stays stable while the shared
// inbox reader owns projection.

import { LegacyKnowledgeProposalQuerySchema } from '@/capabilities/knowledge/api/contracts';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { type ProposalStatus, listLegacyKnowledgeProposals } from '@/kernel/proposals/inbox';

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
