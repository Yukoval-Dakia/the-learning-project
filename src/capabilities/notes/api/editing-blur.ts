// Blur clears this editor's presence and flushes deferred work once no session
// remains.

import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { requestEditingBlur } from '../server/editing-request';

export async function POST(req: Request): Promise<Response> {
  try {
    return Response.json(await requestEditingBlur(db, () => req.json()));
  } catch (err) {
    return errorResponse(err);
  }
}
