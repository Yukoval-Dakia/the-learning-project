// Append-only trait history for the rollback UI, newest first. Payloads are not
// included; this is a revision list.

import { z } from 'zod';
import { db } from '@/db/client';
import { collectionPayload, errorResponse } from '@/kernel/http';
import { getTraitJournalPage } from '../public';

const ParamsSchema = z.object({ id: z.string().trim().min(1) });

export async function GET(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsed = ParamsSchema.safeParse(params);
    if (!parsed.success) {
      return Response.json({ error: 'trait id is required' }, { status: 400 });
    }
    const url = new URL(req.url);
    const rawLimit = url.searchParams.get('limit');
    const parsedLimit = rawLimit === null ? 100 : Number(rawLimit);
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      return Response.json({ error: 'limit must be a positive integer' }, { status: 400 });
    }
    const limit = Math.min(parsedLimit, 200);
    const page = await getTraitJournalPage(db, parsed.data.id, {
      limit,
      cursor: url.searchParams.get('cursor') ?? undefined,
    });
    if (page === null) {
      return Response.json({ error: `unknown trait "${parsed.data.id}"` }, { status: 404 });
    }
    return Response.json(
      collectionPayload(
        page.rows,
        { limit, next_cursor: page.next_cursor },
        {
          journal: page.rows,
          next_cursor: page.next_cursor,
        },
      ),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
