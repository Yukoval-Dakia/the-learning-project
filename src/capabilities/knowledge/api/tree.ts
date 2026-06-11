import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { loadTreeSnapshot } from '@/capabilities/knowledge/server/tree';


export async function GET(): Promise<Response> {
  try {
    const rows = await loadTreeSnapshot(db);
    return Response.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}
