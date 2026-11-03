// GET /api/review/drafts: authentication is enforced upstream.

import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { readPracticeDraftList } from '../server/draft-list-read';

export async function GET(req: Request): Promise<Response> {
  try {
    return Response.json(await readPracticeDraftList(db, new URL(req.url).searchParams));
  } catch (err) {
    return errorResponse(err);
  }
}
