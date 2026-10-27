// GET /api/ingestion/[id]/blocks

import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { readIngestionSessionBlocks } from '../server/session-blocks-read';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    return Response.json(await readIngestionSessionBlocks(db, { id: params.id }));
  } catch (err) {
    return errorResponse(err);
  }
}
