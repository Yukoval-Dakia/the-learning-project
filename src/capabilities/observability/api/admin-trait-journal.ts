// Append-only trait history for the rollback UI, newest first. Payloads are not
// included; this is a revision list.

import { z } from 'zod';
import { db } from '@/db/client';
import { collectionPayload, errorResponse } from '@/kernel/http';
import { getTraitJournalPage } from '../public';
import { parseTraitJournalLimit } from './subjects-write-http';

const ParamsSchema = z.object({ id: z.string().trim().min(1) });

export async function GET(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsed = ParamsSchema.safeParse(params);
    if (!parsed.success) {
      return Response.json({ error: 'trait id is required' }, { status: 400 });
    }
    const url = new URL(req.url);
    const parsedLimit = parseTraitJournalLimit(url.searchParams.get('limit'));
    if (!parsedLimit.ok) return Response.json(parsedLimit.body, { status: parsedLimit.status });
    const { limit } = parsedLimit;
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
