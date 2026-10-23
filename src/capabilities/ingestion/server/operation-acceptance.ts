import { and, eq } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { learning_session } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { resolveSessionDerivationPolicy } from '@/kernel/read-models/usage-policy';
import { getStartedBoss } from '@/server/boss/client';
import { Ingestion } from '@/server/session';
import type { IngestionOperationRequestParsed } from '../api/operation-schema';
import {
  agentOpOwnsSessionRun,
  authorizeAgentRunStart,
  settleAgentRunBudget,
} from './agent/budget';
import { AGENT_BUDGET_EXCEEDED_CODE, AGENT_BUDGET_UNAVAILABLE_CODE } from './agent/budget-state';
import {
  type IngestionOperationResource,
  hasQueuedIngestionOperationEvent,
  ingestionOperationInputHash,
  isTerminalIngestionOperation,
  readIngestionOperation,
  reserveIngestionOperation,
  withIngestionOperationDispatchLock,
  writeIngestionOperationEvent,
  writeIngestionOperationTerminalOnce,
} from './operation-store';

const OPERATION_QUEUE = 'ingestion_operation';
const OPERATION_DISPATCH_SINGLETON_SECONDS = 24 * 60 * 60;

function operationError(err: unknown): { code: string; message: string; status: number } {
  return err instanceof ApiError
    ? { code: err.code, message: err.message, status: err.status }
    : { code: 'internal_error', message: 'Internal Server Error', status: 500 };
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
    review: ['extracted', 'partial'],
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

async function readReservedResource(operationId: string, reader: Db | Tx) {
  const resource = await readIngestionOperation(reader, operationId);
  if (!resource) {
    throw new ApiError('internal_error', `operation ${operationId} could not be read`, 500);
  }
  return resource;
}

/** Own review dispatch, its connection lifetime and commit-before-HTTP failure order. */
async function ensureReviewOperationDispatched(
  db: Db,
  operationId: string,
  sessionId: string,
  request: Extract<IngestionOperationRequestParsed, { kind: 'review' }>,
  freshReservation: boolean,
) {
  const outcome = await withIngestionOperationDispatchLock(
    db,
    operationId,
    async (tx, lifetime) => {
      lifetime.throwIfAborted();
      const current = await readReservedResource(operationId, tx);
      lifetime.throwIfAborted();
      if (isTerminalIngestionOperation(current) || current.status === 'running') {
        return { kind: 'resource' as const, resource: current };
      }
      const queued = await hasQueuedIngestionOperationEvent(tx, operationId);
      lifetime.throwIfAborted();
      if (queued) return { kind: 'resource' as const, resource: current };

      let dispatched = false;
      try {
        const boss = await getStartedBoss();
        lifetime.throwIfAborted();
        const jobId = await boss.send(
          OPERATION_QUEUE,
          { operationId, sessionId, request },
          { singletonKey: operationId, singletonSeconds: OPERATION_DISPATCH_SINGLETON_SECONDS },
        );
        // A closed transaction's Tx may outlive its physical connection. Stop the
        // late send continuation before any receipt/readback, even on reconnection.
        lifetime.throwIfAborted();
        dispatched = true;
        await writeIngestionOperationEvent(tx, {
          operationId,
          eventType: 'operation.queued',
          payload: jobId ? { job_id: jobId } : { dispatch_deduplicated: true },
        });
        lifetime.throwIfAborted();
        const resource = await readReservedResource(operationId, tx);
        lifetime.throwIfAborted();
        return { kind: 'resource' as const, resource };
      } catch (error) {
        // Outer transaction rejection does not cancel boss.send's callback. Never
        // let that stale callback enter a failed receipt via the old Tx or global db.
        lifetime.throwIfAborted();
        if (!dispatched && freshReservation) {
          await writeIngestionOperationTerminalOnce(tx, {
            operationId,
            eventType: 'operation.failed',
            payload: { error: operationError(error) },
          });
          lifetime.throwIfAborted();
        }
        // Returning permits the failure receipt to commit; throwing here rolls it back.
        return { kind: 'error' as const, error };
      }
    },
  );
  if (outcome.kind === 'error') throw outcome.error;
  return outcome.resource;
}

async function ensureOperationDispatched(
  db: Db,
  operationId: string,
  sessionId: string,
  request: IngestionOperationRequestParsed,
  freshReservation: boolean,
) {
  if (request.kind === 'review') {
    return ensureReviewOperationDispatched(db, operationId, sessionId, request, freshReservation);
  }
  return withIngestionOperationDispatchLock(db, operationId, async () => {
    const current = await readReservedResource(operationId, db);
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
            return readReservedResource(operationId, db);
          }
          // Refuse the paid lane up front when the strictest policy forbids
          // derivation; segment entry re-checks as a backstop.
          const policy = await resolveSessionDerivationPolicy(db, sessionId);
          if (policy !== 'allow') {
            throw new ApiError(
              'derivation_policy_forbids_agent',
              `source usage policy '${policy}' does not permit the ingestion agent`,
              422,
            );
          }
          // The budget gate runs in the dispatch transaction. Denials commit the
          // failed identity/evidence; the job insert shares the grant/owner/queued tx.
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
          // Recovery: if another run owns the session this op can never be paid, so
          // fail explicitly instead of leaving a fake queued handle. In-flight means
          // 503; past-terminal means the window was missed (409).
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
            // On a standard pg-boss queue, singletonKey needs singletonSeconds.
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
      return readReservedResource(operationId, db);
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

/** Accepts or resumes an operation from a schema-normalized request. */
export async function acceptIngestionOperation(
  db: Db,
  input: {
    sessionId: string;
    request: IngestionOperationRequestParsed;
    idempotencyKey?: string;
  },
): Promise<{
  outcome: 'created' | 'reused';
  resource: IngestionOperationResource;
}> {
  const { sessionId, request, idempotencyKey } = input;
  const hash = ingestionOperationInputHash(request);

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
      db,
      reservation.operationId,
      sessionId,
      request,
      false,
    );
    return { outcome: 'reused', resource };
  }
  const resource = await ensureOperationDispatched(db, operationId, sessionId, request, true);
  return { outcome: 'created', resource };
}
