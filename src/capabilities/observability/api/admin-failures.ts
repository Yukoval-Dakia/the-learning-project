import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';

import { getAdminFailureClusters } from '../server/ai-observability';

function requestedLimit(value: string | null): number {
  const parsed = Number.parseInt(value ?? '200', 10);
  if (!Number.isFinite(parsed) || !parsed || parsed <= 0) return 50;
  return Math.min(Math.trunc(parsed), 200);
}

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const limit = requestedLimit(url.searchParams.get('limit'));
    const clusters = await getAdminFailureClusters(db, { limit });
    return Response.json({ clusters, limit });
  } catch (err) {
    return errorResponse(err);
  }
}
