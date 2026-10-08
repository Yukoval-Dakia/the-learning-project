import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

import { AdminRunParamsSchema, loadAdminRunDetail } from '../public';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const { id } = AdminRunParamsSchema.parse(params);
    const detail = await loadAdminRunDetail(db, { id });
    if (!detail) {
      return Response.json({ error: 'not_found', message: `no run ${id}` }, { status: 404 });
    }
    return Response.json(detail);
  } catch (err) {
    return errorResponse(err);
  }
}
