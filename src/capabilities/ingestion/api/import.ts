import { db } from '@/db/client';
import { ApiError, deprecatedRouteResponse, errorResponse } from '@/kernel/http';
import { completeIngestionImport } from '../server/import-completion';
import { ImportBody } from './import-schema';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
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
    const successor = `/api/ingestion-sessions/${encodeURIComponent(params.id ?? '')}/operations`;
    return deprecatedRouteResponse(Response.json(result), successor);
  } catch (err) {
    return errorResponse(err);
  }
}
