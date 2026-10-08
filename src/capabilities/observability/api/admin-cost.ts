import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

import { loadAdminCost, parseAdminCostQuery } from '../public';

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const options = parseAdminCostQuery({ days: url.searchParams.get('days') ?? undefined });
    const cost = await loadAdminCost(db, options);
    return Response.json(cost);
  } catch (err) {
    return errorResponse(err);
  }
}
