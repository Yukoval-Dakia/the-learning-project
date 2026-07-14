import { deprecatedRouteResponse } from '@/kernel/http';
import { POST as createPaperSession, GET as getPapers } from './papers-list';

export async function GET(): Promise<Response> {
  return deprecatedRouteResponse(await getPapers(), '/api/papers');
}

export async function POST(req: Request): Promise<Response> {
  return deprecatedRouteResponse(await createPaperSession(req), '/api/review-sessions');
}
