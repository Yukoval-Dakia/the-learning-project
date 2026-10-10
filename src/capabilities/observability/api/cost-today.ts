// Daily cost summary for the /today cost ribbon, grouped by currency.
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { loadTodayCost } from '../public';

export async function GET(_req: Request): Promise<Response> {
  try {
    return Response.json(await loadTodayCost(db));
  } catch (err) {
    return errorResponse(err);
  }
}
