// GET /api/placement/profile retains the shared placement profile read contract.
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { readPlacementProfile } from '../server/placement-profile';

export async function GET(req: Request): Promise<Response> {
  try {
    return Response.json(await readPlacementProfile(db, new URL(req.url).searchParams.get('goal')));
  } catch (err) {
    return errorResponse(err);
  }
}
