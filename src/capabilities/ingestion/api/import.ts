import { deprecatedRouteResponse } from '@/kernel/http';
import { completeIngestionImport } from '../server/import-completion';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  const successor = `/api/ingestion-sessions/${encodeURIComponent(params.id ?? '')}/operations`;
  return deprecatedRouteResponse(await completeIngestionImport(req, params), successor);
}
