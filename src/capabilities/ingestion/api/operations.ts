import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { learning_session } from '@/db/schema';
import { getStartedBoss } from '@/server/boss/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { Ingestion } from '@/server/session';
import {
  findIdempotentIngestionOperation,
  hasQueuedIngestionOperationEvent,
  isTerminalIngestionOperation,
  readIngestionOperation,
  reserveIngestionOperation,
  withIngestionOperationDispatchLock,
  writeIngestionOperationEvent,
} from '../server/operation-store';
import {
  IngestionOperationRequest,
  type IngestionOperationRequestParsed,
} from './operation-schema';

const OPERATION_QUEUE = 'ingestion_operation';
const IDEMPOTENCY_KEY_MAX_LENGTH = 200;
const OPERATION_DISPATCH_SINGLETON_SECONDS = 24 * 60 * 60;

function resourcePath(operationId: string): string {
  return `/api/ingestion-operations/${encodeURIComponent(operationId)}`;
}

function inputHash(request: IngestionOperationRequestParsed): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

function operationError(err: unknown): { code: string; message: string; status: number } {
  return err instanceof ApiError
    ? { code: err.code, message: err.message, status: err.status }
    : { code: 'internal_error', message: 'Internal Server Error', status: 500 };
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

async function validateSessionState(
  sessionId: string,
  request: IngestionOperationRequestParsed,
): Promise<void> {
  const rows = await db
    .select({ status: learning_session.status })
    .from(learning_session)
    .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')))
    .limit(1);
  const session = rows[0];
  if (!session) {
    throw new ApiError('not_found', `ingestion session ${sessionId} not found`, 404);
  }

  const allowedStatuses: Record<IngestionOperationRequestParsed['kind'], string[]> = {
    extract: ['uploaded', 'failed'],
    import: ['extracted', 'reviewed'],
    make_paper: ['imported'],
    rescue: ['partial', 'extracted'],
  };
  const allowed = allowedStatuses[request.kind];
  if (!allowed.includes(session.status)) {
    throw new ApiError(
      'conflict',
      `ingestion session ${sessionId} is in status '${session.status}'; operation '${request.kind}' requires ${allowed.map((status) => `'${status}'`).join(' or ')}`,
      409,
    );
  }
}

async function readReservedResource(operationId: string) {
  const resource = await readIngestionOperation(db, operationId);
  if (!resource) {
    throw new ApiError('internal_error', `operation ${operationId} could not be read`, 500);
  }
  return resource;
}

async function ensureOperationDispatched(
  operationId: string,
  sessionId: string,
  request: IngestionOperationRequestParsed,
  onDispatched?: () => void,
) {
  return withIngestionOperationDispatchLock(db, operationId, async () => {
    const current = await readReservedResource(operationId);
    if (
      isTerminalIngestionOperation(current) ||
      current.status === 'running' ||
      (await hasQueuedIngestionOperationEvent(db, operationId))
    ) {
      return current;
    }

    const boss = await getStartedBoss();
    let jobId: string | null = null;
    if (request.kind === 'extract') {
      const rows = await db
        .select({ status: learning_session.status })
        .from(learning_session)
        .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')))
        .limit(1);
      const status = rows[0]?.status;
      if (!status) throw new ApiError('not_found', `ingestion session ${sessionId} not found`, 404);

      if (status === 'uploaded' || status === 'failed') {
        ({ jobId } = await Ingestion.enqueueExtraction({ db, boss, sessionId, operationId }));
      } else if (
        !['queued', 'extracting', 'extracted', 'partial', 'reviewed', 'imported'].includes(status)
      ) {
        throw new ApiError(
          'conflict',
          `ingestion session ${sessionId} cannot resume extract dispatch from status '${status}'`,
          409,
        );
      }
    } else {
      jobId = await boss.send(
        OPERATION_QUEUE,
        { operationId, sessionId, request },
        {
          // Context7 / pg-boss v12: singletonKey on a standard queue only
          // dedupes when singletonSeconds defines the throttle window.
          singletonKey: operationId,
          singletonSeconds: OPERATION_DISPATCH_SINGLETON_SECONDS,
        },
      );
      // null means this operation was already accepted inside the singleton window.
    }
    onDispatched?.();
    await writeIngestionOperationEvent(db, {
      operationId,
      eventType: 'operation.queued',
      payload: jobId ? { job_id: jobId } : { dispatch_deduplicated: true },
    });
    return readReservedResource(operationId);
  });
}

/** POST /api/ingestion-sessions/[id]/operations —— 创建可轮询的录入 operation。 */
export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  let createdOperationId: string | undefined;
  let dispatched = false;
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

    const request = parsed.data;
    const hash = inputHash(request);

    // 重放必须先于当前 session-state 校验：首个 extract 已把 uploaded 推成 queued，
    // 同 key 重试仍应拿回原 handle，而不是被新的状态挡成 409。
    if (idempotencyKey) {
      const existing = await findIdempotentIngestionOperation(db, {
        sessionId,
        idempotencyKey,
      });
      if (existing) {
        if (existing.operationKind !== request.kind || existing.inputHash !== hash) {
          throw new ApiError(
            'idempotency_conflict',
            `Idempotency-Key is already bound to operation ${existing.operationId}`,
            409,
          );
        }
        const resource = await ensureOperationDispatched(existing.operationId, sessionId, request);
        return resourceResponse(resource, 200);
      }
    }

    await validateSessionState(sessionId, request);

    const operationId = `ingop_${newId()}`;
    const reservation = await reserveIngestionOperation(db, {
      operationId,
      sessionId,
      operationKind: request.kind,
      inputHash: hash,
      idempotencyKey,
    });
    if (reservation.outcome === 'conflict') {
      throw new ApiError(
        'idempotency_conflict',
        `Idempotency-Key is already bound to operation ${reservation.operationId}`,
        409,
      );
    }
    if (reservation.outcome === 'reused') {
      const resource = await ensureOperationDispatched(reservation.operationId, sessionId, request);
      return resourceResponse(resource, 200);
    }
    createdOperationId = operationId;
    const resource = await ensureOperationDispatched(operationId, sessionId, request, () => {
      dispatched = true;
    });
    return resourceResponse(resource, 202);
  } catch (err) {
    // boss 已接收 job 后，即使后续 queued-event/readback 短暂失败也不能把真实运行中的
    // operation 标成 failed；同 Idempotency-Key 重试会读回 accepted handle，worker/抽取
    // session 的后续事件继续推进资源快照。
    if (createdOperationId && !dispatched) {
      try {
        await writeIngestionOperationEvent(db, {
          operationId: createdOperationId,
          eventType: 'operation.failed',
          payload: { error: operationError(err) },
        });
      } catch (writeErr) {
        console.error('failed to record ingestion operation dispatch failure', writeErr);
      }
    }
    return errorResponse(err);
  }
}

/** GET /api/ingestion-operations/[id] —— one-shot operation 快照。 */
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
