import { db } from '@/db/client';
import { deprecatedRouteResponse, errorResponse } from '@/kernel/http';
import { requestPracticeSolveHint } from '../server/solve-operations';

export async function createHintRequest(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    return Response.json(await requestPracticeSolveHint(db, params.id, params.sid, raw));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  const response = await createHintRequest(req, params);
  return deprecatedRouteResponse(response, `/api/solve-sessions/${params.sid}/hint-requests`);
}
