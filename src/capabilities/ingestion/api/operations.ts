import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { newId } from '@/core/ids';
import { type Tx, db } from '@/db/client';
import { learning_session } from '@/db/schema';
import { ApiError, errorResponse } from '@/kernel/http';
import { resolveSessionDerivationPolicy } from '@/kernel/read-models/usage-policy';
import { getStartedBoss } from '@/server/boss/client';
import { Ingestion } from '@/server/session';
import {
  agentOpOwnsSessionRun,
  authorizeAgentRunStart,
  settleAgentRunBudget,
} from '../server/agent/budget';
import {
  AGENT_BUDGET_EXCEEDED_CODE,
  AGENT_BUDGET_UNAVAILABLE_CODE,
} from '../server/agent/budget-state';
import {
  hasQueuedIngestionOperationEvent,
  isTerminalIngestionOperation,
  readIngestionOperation,
  reserveIngestionOperation,
  withIngestionOperationDispatchLock,
  writeIngestionOperationEvent,
  writeIngestionOperationTerminalOnce,
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
  tx: Tx,
): Promise<void> {
  const rows = await tx
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
    agent: ['uploaded', 'failed'],
    import: [...Ingestion.IMPORTABLE_SESSION_STATUSES],
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
  freshReservation: boolean,
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

    let dispatched = false;
    try {
      const boss = await getStartedBoss();
      let jobId: string | null = null;
      if (request.kind === 'agent') {
        const rows = await db
          .select({ status: learning_session.status })
          .from(learning_session)
          .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')))
          .limit(1);
        const status = rows[0]?.status;
        if (!status)
          throw new ApiError('not_found', `ingestion session ${sessionId} not found`, 404);

        if (status === 'uploaded' || status === 'failed') {
          if (await agentOpOwnsSessionRun(db, sessionId, operationId)) {
            // A grant/job proves this handle already entered dispatch. An
            // accepted stale snapshot cannot turn it into a second paid run.
            await db.transaction((tx) =>
              settleAgentRunBudget(tx, {
                sessionId,
                operationId,
                terminal: 'failed',
                executionClosed: false,
                error: {
                  code: 'dispatch_already_owned',
                  message: 'Original dispatch cannot be restarted',
                },
              }),
            );
            return readReservedResource(operationId);
          }
          // R2-8 — refuse the paid agent lane up front when the document's
          // strictest derivation policy forbids derivation (answer_only/crisis);
          // the segment-entry policy_blocked error is the backstop.
          const policy = await resolveSessionDerivationPolicy(db, sessionId);
          if (policy !== 'allow') {
            throw new ApiError(
              'derivation_policy_forbids_agent',
              `source usage policy '${policy}' does not permit the ingestion agent`,
              422,
            );
          }
          // YUK-1522 — weekly budget gate: authorizeAgentRunStart runs inside
          // the dispatch transaction. Expected denials commit the failed
          // identity/evidence and return before queued/send. The agent job INSERT
          // uses the same transaction as the grant, owner and queued transition.
          const dispatch = await Ingestion.enqueueAgentRun({
            db,
            boss,
            sessionId,
            operationId,
            beforeTransition: (tx) => authorizeAgentRunStart(tx, { sessionId, operationId }),
          });
          if (dispatch.error) throw dispatch.error;
          jobId = dispatch.jobId;
        } else if (
          !['queued', 'extracting', 'extracted', 'partial', 'reviewed', 'imported'].includes(status)
        ) {
          throw new ApiError(
            'conflict',
            `ingestion session ${sessionId} cannot resume agent dispatch from status '${status}'`,
            409,
          );
        } else if (!(await agentOpOwnsSessionRun(db, sessionId, operationId))) {
          // YUK-1522 — recovery path: the session is past 'uploaded|failed' and
          // this op does NOT own its agent run → it can never be paid → explicit
          // failure, not a fake 'queued' zombie handle. queued|extracting means
          // another run is in flight (503); past-terminal statuses mean the op
          // missed its window entirely (409).
          const inFlight = status === 'queued' || status === 'extracting';
          const err = inFlight
            ? {
                code: AGENT_BUDGET_UNAVAILABLE_CODE,
                message: '另一个录入还在进行中，请等它结束后再试。',
                status: 503,
              }
            : {
                code: 'conflict',
                message: `ingestion session ${sessionId} is '${status}'; this operation can no longer dispatch`,
                status: 409,
              };
          await writeIngestionOperationTerminalOnce(db, {
            operationId,
            eventType: 'operation.failed',
            payload: { error: err },
          });
          throw new ApiError(
            err.code,
            err.message,
            err.status,
            undefined,
            inFlight ? { reason: 'another_ingestion_in_flight' } : undefined,
          );
        }
      } else if (request.kind === 'extract') {
        const rows = await db
          .select({ status: learning_session.status })
          .from(learning_session)
          .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')))
          .limit(1);
        const status = rows[0]?.status;
        if (!status)
          throw new ApiError('not_found', `ingestion session ${sessionId} not found`, 404);

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
      dispatched = true;
      await writeIngestionOperationEvent(db, {
        operationId,
        eventType: 'operation.queued',
        payload: jobId ? { job_id: jobId } : { dispatch_deduplicated: true },
      });
      return readReservedResource(operationId);
    } catch (error) {
      const budgetRejection =
        error instanceof ApiError &&
        [AGENT_BUDGET_EXCEEDED_CODE, AGENT_BUDGET_UNAVAILABLE_CODE].includes(error.code);
      if (!dispatched && (freshReservation || budgetRejection)) {
        // Still under the per-op lock: a late failure cannot race a replay's
        // successful dispatch. A committed/ambiguous send remains recoverable.
        const ownsRun =
          request.kind === 'agent' && (await agentOpOwnsSessionRun(db, sessionId, operationId));
        if (!ownsRun)
          await writeIngestionOperationTerminalOnce(db, {
            operationId,
            eventType: 'operation.failed',
            payload: { error: operationError(error) },
          });
      }
      throw error;
    }
  });
}

/** POST /api/ingestion-sessions/[id]/operations —— 创建可轮询的录入 operation。 */
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

    const request = parsed.data;
    const hash = inputHash(request);

    // Replay, session validation and reservation share the real key lock.
    const operationId = `ingop_${newId()}`;
    const reservation = await reserveIngestionOperation(db, {
      operationId,
      sessionId,
      operationKind: request.kind,
      inputHash: hash,
      idempotencyKey,
      beforeReserve: (tx) => validateSessionState(sessionId, request, tx),
    });
    if (reservation.outcome === 'conflict') {
      throw new ApiError(
        'idempotency_conflict',
        `Idempotency-Key is already bound to operation ${reservation.operationId}`,
        409,
      );
    }
    if (reservation.outcome === 'reused') {
      const resource = await ensureOperationDispatched(
        reservation.operationId,
        sessionId,
        request,
        false,
      );
      return resourceResponse(resource, 200);
    }
    const resource = await ensureOperationDispatched(operationId, sessionId, request, true);
    return resourceResponse(resource, 202);
  } catch (err) {
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
