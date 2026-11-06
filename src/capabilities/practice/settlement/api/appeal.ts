import { db } from '@/db/client';
import { canonicalResourceResponse, deprecatedRouteResponse, errorResponse } from '@/kernel/http';
import { createPracticeAppeal } from '../server/appeal-operation';
import { readAppealStatus } from '../server/appeal-status';

export function createAppeal(req: Request): Promise<Response> {
  return createPracticeAppeal(db, () => req.json());
}

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    return Response.json(await readAppealStatus(db, params.id));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function createAppealResource(req: Request): Promise<Response> {
  return canonicalResourceResponse(await createAppeal(req), {
    outcome: 'created',
    location: (body) =>
      `/api/events/${encodeURIComponent((body as { appeal_event_id: string }).appeal_event_id)}`,
  });
}

export async function POST(req: Request): Promise<Response> {
  return deprecatedRouteResponse(await createAppeal(req), '/api/appeals');
}
