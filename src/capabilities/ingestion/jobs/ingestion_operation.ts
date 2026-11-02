import type { Job } from 'pg-boss';

import {
  IngestionOperationRequest,
  type IngestionOperationRequestParsed,
} from '@/capabilities/ingestion/api/operation-schema';
import {
  completeIngestionImportOperation,
  completeIngestionReviewOperation,
} from '@/capabilities/ingestion/server/import-completion';
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
  // 'agent' is dispatched in the POST handler and never reaches this adapter.
  request: Exclude<
    IngestionOperationRequestParsed,
    { kind: 'extract' | 'import' | 'review' | 'agent' }
  >,
): Promise<Response> {
  switch (request.kind) {
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
 * Import/review call their transactional business owner directly. Make-paper/rescue retain
 * their legacy adapters until their distinct lifecycle owners are migrated.
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
      const reserved = operationId ? await readIngestionOperation(db, operationId) : null;
      if (reserved?.operation_kind === 'review') {
        if (isTerminalIngestionOperation(reserved)) continue;
        if (!sessionId || !parsed.success || parsed.data.kind !== 'review') {
          // Do not send a review handle through a legacy/paid adapter, or replace
          // its receipt because a malformed/foreign delivery reused the id.
          throw new Error('Review delivery must carry its accepted review request');
        }
      }
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

      if (parsed.data.kind === 'review') {
        await completeIngestionReviewOperation(db, {
          operationId,
          sessionId,
          body: parsed.data.input,
        });
        continue;
      }

      if (parsed.data.kind === 'import') {
        await completeIngestionImportOperation(db, {
          operationId,
          sessionId,
          body: parsed.data.input,
        });
        continue;
      }

      if (parsed.data.kind === 'agent') {
        // 'agent' has no legacy adapter; such a job can only be stale or foreign,
        // so record an honest failure instead of dropping it.
        await writeIngestionOperationEvent(db, {
          operationId,
          eventType: 'operation.failed',
          payload: {
            error: {
              code: 'invalid_job_payload',
              message: 'agent operations are dispatched inline, not through ingestion_operation',
              status: 500,
            },
          },
        });
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
