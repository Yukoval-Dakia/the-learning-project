import { db } from '@/db/client';
import { canonicalResourceResponse, deprecatedRouteResponse } from '@/kernel/http';
import { createPracticeAppeal } from '../server/appeal-operation';

export function createAppeal(req: Request): Promise<Response> {
  return createPracticeAppeal(db, () => req.json());
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
