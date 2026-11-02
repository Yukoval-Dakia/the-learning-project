import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { readIngestionSessionHistory } from '../server/session-history-read';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    return Response.json(await readIngestionSessionHistory(db, params));
  } catch (err) {
    return errorResponse(err);
  }
}
