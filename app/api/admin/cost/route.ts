import { db } from '@/db/client';
import { getAdminCost } from '@/server/admin/ai-observability';
import { errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const days = Number.parseInt(url.searchParams.get('days') ?? '30', 10);
    const cost = await getAdminCost(db, { days });
    return Response.json(cost);
  } catch (err) {
    return errorResponse(err);
  }
}
