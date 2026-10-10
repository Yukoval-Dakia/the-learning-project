import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { readProposalInbox } from '../server/proposal-inbox-read';

export async function GET(req: Request): Promise<Response> {
  try {
    const query = new URL(req.url).searchParams;
    return Response.json(
      await readProposalInbox(db, {
        limit: query.get('limit') ?? undefined,
        status: query.get('status') ?? undefined,
        kind: query.get('kind') ?? undefined,
        lane: query.get('lane') ?? undefined,
        cursor: query.get('cursor') ?? undefined,
      }),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
