import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

import { loadAdminFailures, parseAdminFailuresQuery } from '../public';

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const options = parseAdminFailuresQuery({ limit: url.searchParams.get('limit') ?? undefined });
    return Response.json(await loadAdminFailures(db, options));
  } catch (err) {
    return errorResponse(err);
  }
}
