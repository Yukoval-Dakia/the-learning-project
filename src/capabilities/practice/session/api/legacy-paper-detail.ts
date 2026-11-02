import { deprecatedRouteResponse } from '@/kernel/http';
import { GET as getPaper } from './paper-detail-route';

export async function GET(req: Request, params: Record<string, string>): Promise<Response> {
  const successor = `/api/papers/${encodeURIComponent(params.id)}`;
  return deprecatedRouteResponse(await getPaper(req, params), successor);
}
