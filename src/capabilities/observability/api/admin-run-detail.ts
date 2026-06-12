import { z } from 'zod';

import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';

import { getAdminRunTimeline } from '../server/ai-observability';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const { id } = z.object({ id: z.string().min(1) }).parse(params);
    const detail = await getAdminRunTimeline(db, id);
    if (!detail) {
      return Response.json({ error: 'not_found', message: `no run ${id}` }, { status: 404 });
    }
    return Response.json(detail);
  } catch (err) {
    return errorResponse(err);
  }
}
