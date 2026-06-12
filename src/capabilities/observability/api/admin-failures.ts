import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';

import { getAdminFailureClusters } from '../server/ai-observability';

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
    const clusters = await getAdminFailureClusters(db, { limit });
    return Response.json({ clusters, limit: Math.min(Math.max(limit || 200, 1), 200) });
  } catch (err) {
    return errorResponse(err);
  }
}
