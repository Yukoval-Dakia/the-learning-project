import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { IngestionOperationRequest } from '../api/operation-schema';
import { acceptIngestionOperation } from './operation-acceptance';

const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

export interface IngestionOperationResponse {
  resource: Awaited<ReturnType<typeof acceptIngestionOperation>>['resource'];
  status: 200 | 202;
  headers: Record<string, string>;
}

/** Own the complete operation request and resource-response policy. */
export async function requestIngestionOperation(
  db: Db,
  params: Record<string, string>,
  readBody: () => Promise<unknown>,
  rawIdempotencyKey: string | null,
): Promise<IngestionOperationResponse> {
  const sessionId = params.id;
  if (!sessionId) throw new ApiError('validation_error', 'session id is required', 400);

  const raw = await readBody().catch(() => null);
  const parsed = IngestionOperationRequest.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      'validation_error',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      400,
    );
  }

  const idempotencyKey = rawIdempotencyKey?.trim() || undefined;
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
  const headers: Record<string, string> = {
    Location: `/api/ingestion-operations/${encodeURIComponent(resource.id)}`,
    'Cache-Control': 'no-store',
  };
  if (resource.status === 'queued' || resource.status === 'running') {
    headers['Retry-After'] = '1';
  }
  return { resource, status: outcome === 'created' ? 202 : 200, headers };
}
