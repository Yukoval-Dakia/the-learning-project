import { ApiError, apiFetch, apiJson } from './api';
import { randomId } from './random-id';

export type IngestionOperationRequest =
  | { kind: 'extract' }
  | { kind: 'import'; input: unknown }
  | { kind: 'review'; input: { checked_blocks: { block_id: string; version: number }[] } }
  | { kind: 'make_paper'; input?: { question_ids?: string[] } }
  | {
      kind: 'rescue';
      input: {
        block_id: string;
        page: number;
        tier: 2 | 3;
        strategy?: 'extract' | 'restructure_cloze' | 'restructure_compound';
      };
    };

export interface IngestionOperationResource<Result = unknown> {
  id: string;
  kind: 'ingestion_operation';
  operation_kind: IngestionOperationRequest['kind'];
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  session_id: string;
  job_id?: string;
  result?: Result;
  error?: { code: string; message: string; status: number };
  created_at: string;
  updated_at: string;
  events_url: string;
}

function newIdempotencyKey(): string {
  return randomId();
}

export async function startIngestionOperation<Result = unknown>(
  sessionId: string,
  request: IngestionOperationRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<{ resource: IngestionOperationResource<Result>; location: string }> {
  const response = await apiFetch(
    `/api/ingestion-sessions/${encodeURIComponent(sessionId)}/operations`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(request),
    },
  );
  const resource = (await response.json()) as IngestionOperationResource<Result>;
  const location =
    response.headers.get('Location') ??
    `/api/ingestion-operations/${encodeURIComponent(resource.id)}`;
  return { resource, location };
}

export async function runIngestionOperation<Result = unknown>(
  sessionId: string,
  request: IngestionOperationRequest,
  /** idempotencyKey: pass the same key on a retry so a lost response replays the same operation. */
  options: { timeoutMs?: number; pollIntervalMs?: number; idempotencyKey?: string } = {},
): Promise<Result> {
  const { timeoutMs = 5 * 60_000, pollIntervalMs = 1_000 } = options;
  const started = await startIngestionOperation<Result>(sessionId, request, options.idempotencyKey);
  let operation = started.resource;
  const deadline = Date.now() + timeoutMs;

  while (operation.status === 'queued' || operation.status === 'running') {
    if (Date.now() >= deadline) {
      throw new ApiError('录入任务等待超时，请稍后重试。', 504, 'operation_timeout', {
        operation_id: operation.id,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    operation = await apiJson<IngestionOperationResource<Result>>(started.location, {
      cache: 'no-store',
    });
  }

  if (operation.status === 'failed') {
    throw new ApiError(
      operation.error?.message ?? '录入任务失败',
      operation.error?.status ?? 500,
      operation.error?.code ?? 'operation_failed',
      { operation_id: operation.id },
    );
  }
  return operation.result as Result;
}
