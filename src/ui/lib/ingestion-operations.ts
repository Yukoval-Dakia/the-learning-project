import { ApiError, apiFetch, apiJson } from './api';

export type IngestionOperationRequest =
  | { kind: 'extract' }
  | { kind: 'import'; input: unknown }
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
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export async function startIngestionOperation<Result = unknown>(
  sessionId: string,
  request: IngestionOperationRequest,
): Promise<{ resource: IngestionOperationResource<Result>; location: string }> {
  const response = await apiFetch(
    `/api/ingestion-sessions/${encodeURIComponent(sessionId)}/operations`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': newIdempotencyKey() },
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
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<Result> {
  const { timeoutMs = 5 * 60_000, pollIntervalMs = 1_000 } = options;
  const started = await startIngestionOperation<Result>(sessionId, request);
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
