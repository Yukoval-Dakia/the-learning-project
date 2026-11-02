import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { readCopilotTurns } from '../server/turns-request';

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const snapshot = await readCopilotTurns(db, url.searchParams);
    return Response.json(snapshot);
  } catch (err) {
    return errorResponse(err);
  }
}
