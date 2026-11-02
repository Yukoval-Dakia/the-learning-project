import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { readTutorSessionDetail } from '../server/tutor-session';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    return Response.json(await readTutorSessionDetail(db, params.sid));
  } catch (err) {
    return errorResponse(err);
  }
}
