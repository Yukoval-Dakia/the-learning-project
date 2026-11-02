import { db } from '@/db/client';
import { deprecatedRouteResponse, errorResponse } from '@/kernel/http';
import { startPracticeSolveSession } from '../server/solve-operations';

export async function createSolveSession(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    return Response.json(await startPracticeSolveSession(db, params.id, raw));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  return deprecatedRouteResponse(await createSolveSession(req, params), '/api/solve-sessions');
}
