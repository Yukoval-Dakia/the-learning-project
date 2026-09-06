import { db } from '@/db/client';
import { ApiError, deprecatedRouteResponse, errorResponse } from '@/kernel/http';
import { completeIngestionImport } from '../server/import-completion';
import { ImportBody } from './import-schema';

async function executePOST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsed = ImportBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const result = await completeIngestionImport(db, params.id ?? '', parsed.data);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  const successor = `/api/ingestion-sessions/${encodeURIComponent(params.id ?? '')}/operations`;
  return deprecatedRouteResponse(await executePOST(req, params), successor);
}
