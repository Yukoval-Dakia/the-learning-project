import { deprecatedRouteResponse } from '@/kernel/http';
import { POST as createReviewSession } from './sessions';

export async function POST(): Promise<Response> {
  return deprecatedRouteResponse(await createReviewSession(), '/api/review-sessions');
}
