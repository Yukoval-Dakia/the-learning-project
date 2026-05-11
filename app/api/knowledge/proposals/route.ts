import { db } from '@/db/client';
import { dreaming_proposal } from '@/db/schema';
import { errorResponse } from '@/server/http/errors';
import { and, desc, eq } from 'drizzle-orm';

export const runtime = 'nodejs';

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const status = url.searchParams.get('status') ?? 'pending';

    const rows = await db
      .select({
        id: dreaming_proposal.id,
        kind: dreaming_proposal.kind,
        payload: dreaming_proposal.payload,
        reasoning: dreaming_proposal.reasoning,
        status: dreaming_proposal.status,
        proposed_at: dreaming_proposal.proposed_at,
        decided_at: dreaming_proposal.decided_at,
      })
      .from(dreaming_proposal)
      .where(and(eq(dreaming_proposal.kind, 'knowledge'), eq(dreaming_proposal.status, status)))
      .orderBy(desc(dreaming_proposal.proposed_at));

    return Response.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}
