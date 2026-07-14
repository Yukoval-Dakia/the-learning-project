import type { Job } from 'pg-boss';

import {
  IngestionOperationRequest,
  type IngestionOperationRequestParsed,
} from '@/capabilities/ingestion/api/operation-schema';
import {
  isTerminalIngestionOperation,
  readIngestionOperation,
  writeIngestionOperationEvent,
} from '@/capabilities/ingestion/server/operation-store';
import type { Db } from '@/db/client';

export interface IngestionOperationJobData {
  operationId: string;
  sessionId: string;
  request: IngestionOperationRequestParsed;
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function executeLegacyOperation(
  sessionId: string,
  request: Exclude<IngestionOperationRequestParsed, { kind: 'extract' }>,
): Promise<Response> {
  switch (request.kind) {
    case 'import': {
      const { POST } = await import('@/capabilities/ingestion/api/import');
      return POST(jsonRequest(`/api/ingestion/${sessionId}/import`, request.input), {
        id: sessionId,
      });
    }
    case 'make_paper': {
      const { POST } = await import('@/capabilities/ingestion/api/make-paper');
      return POST(jsonRequest(`/api/ingestion/${sessionId}/make-paper`, request.input), {
        id: sessionId,
      });
    }
    case 'rescue': {
      const { POST } = await import('@/capabilities/ingestion/api/rescue');
      return POST(jsonRequest(`/api/ingestion/${sessionId}/rescue`, request.input), {
        id: sessionId,
      });
    }
  }
}

export type ExecuteIngestionOperation = typeof executeLegacyOperation;

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.json().catch(() => null);
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/**
 * Canonical operation 的兼容执行器：复用现有 import/make-paper/rescue 业务边界，
 * 不改其事务、状态机或 Vision 选择；只把同步 HTTP 结果投影成 durable operation 事件。
 */
export function buildIngestionOperationHandler(
  db: Db,
  deps: { executeOperation?: ExecuteIngestionOperation } = {},
): (jobs: Job<IngestionOperationJobData>[]) => Promise<void> {
  const executeOperation = deps.executeOperation ?? executeLegacyOperation;
  return async (jobs) => {
    for (const job of jobs) {
      const operationId = job.data?.operationId;
      const sessionId = job.data?.sessionId;
      const parsed = IngestionOperationRequest.safeParse(job.data?.request);
      if (!operationId || !sessionId || !parsed.success || parsed.data.kind === 'extract') {
        if (operationId) {
          await writeIngestionOperationEvent(db, {
            operationId,
            eventType: 'operation.failed',
            payload: {
              error: {
                code: 'invalid_job_payload',
                message: 'ingestion operation job payload is invalid',
                status: 500,
              },
            },
          });
        }
        continue;
      }

      const existing = await readIngestionOperation(db, operationId);
      if (!existing || isTerminalIngestionOperation(existing)) continue;

      await writeIngestionOperationEvent(db, {
        operationId,
        eventType: 'operation.running',
        payload: { pg_boss_job_id: job.id },
      });

      try {
        const response = await executeOperation(sessionId, parsed.data);
        const body = await responseBody(response);
        if (!response.ok) {
          await writeIngestionOperationEvent(db, {
            operationId,
            eventType: 'operation.failed',
            payload: {
              error: {
                code: typeof body.error === 'string' ? body.error : 'operation_failed',
                message:
                  typeof body.message === 'string' ? body.message : 'Ingestion operation failed',
                status: response.status,
              },
            },
          });
          continue;
        }

        await writeIngestionOperationEvent(db, {
          operationId,
          eventType: 'operation.completed',
          payload: { result: body },
        });
      } catch (err) {
        console.error(`[ingestion_operation] ${operationId} failed`, err);
        await writeIngestionOperationEvent(db, {
          operationId,
          eventType: 'operation.failed',
          payload: {
            error: {
              code: 'internal_error',
              message: 'Internal Server Error',
              status: 500,
            },
          },
        });
      }
    }
  };
}
