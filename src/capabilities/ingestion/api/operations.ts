import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { acceptIngestionOperation } from '../server/operation-acceptance';
import { readIngestionOperation } from '../server/operation-store';
import { IngestionOperationRequest } from './operation-schema';

const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

function resourcePath(operationId: string): string {
  return `/api/ingestion-operations/${encodeURIComponent(operationId)}`;
}

function resourceResponse(
  resource: NonNullable<Awaited<ReturnType<typeof readIngestionOperation>>>,
  status: 200 | 202,
): Response {
  const headers = new Headers({
    Location: resourcePath(resource.id),
    'Cache-Control': 'no-store',
  });
  if (resource.status === 'queued' || resource.status === 'running') {
    headers.set('Retry-After', '1');
  }
  return Response.json(resource, { status, headers });
}

/** Creates a pollable ingestion operation. */
export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const sessionId = params.id;
    if (!sessionId) throw new ApiError('validation_error', 'session id is required', 400);

    const raw = await req.json().catch(() => null);
    const parsed = IngestionOperationRequest.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        400,
      );
    }

    const idempotencyKey = req.headers.get('Idempotency-Key')?.trim() || undefined;
    if (idempotencyKey && idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      throw new ApiError(
        'validation_error',
        `Idempotency-Key must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
        400,
      );
    }

    const { outcome, resource } = await acceptIngestionOperation(db, {
      sessionId,
      request: parsed.data,
      idempotencyKey,
    });
    return resourceResponse(resource, outcome === 'created' ? 202 : 200);
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
