import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { requestIngestionOperation } from '../server/operation-request';
import { readIngestionOperation } from '../server/operation-store';

/** Creates a pollable ingestion operation. */
export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const result = await requestIngestionOperation(
      db,
      params,
      () => req.json(),
      req.headers.get('Idempotency-Key'),
    );
    return Response.json(result.resource, { status: result.status, headers: result.headers });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Returns a one-shot operation snapshot. */
export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const operationId = params.id;
    if (!operationId) throw new ApiError('validation_error', 'operation id is required', 400);
    const resource = await readIngestionOperation(db, operationId);
    if (!resource) {
      throw new ApiError('not_found', `ingestion operation ${operationId} not found`, 404);
    }
    const headers = new Headers({ 'Cache-Control': 'no-store' });
    if (resource.status === 'queued' || resource.status === 'running') {
      headers.set('Retry-After', '1');
    }
    return Response.json(resource, { headers });
  } catch (err) {
    return errorResponse(err);
  }
}
