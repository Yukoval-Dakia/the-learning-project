// GET /api/prep-desk/conjectures route shell; the read model lives in
// ../server/prep-desk.

import { loadPrepDeskConjectures } from '@/capabilities/shell/server/prep-desk';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await loadPrepDeskConjectures(db));
  } catch (err) {
    return errorResponse(err);
  }
}
