import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { learning_session } from '@/db/schema';
import { ApiError, errorResponse } from '@/kernel/http';
import { resolveSessionDerivationPolicy } from '@/kernel/read-models/usage-policy';
import { getStartedBoss } from '@/server/boss/client';
import { Ingestion } from '@/server/session';
import {
  AGENT_BUDGET_EXCEEDED_CODE,
  AGENT_BUDGET_UNAVAILABLE_CODE,
  AgentBudgetReplayError,
  agentKeyDigest,
  agentOpOwnsSessionRun,
  authorizeAgentRunStart,
  findAgentGrantByKeyDigest,
  hasUnboundAgentGrants,
  readAgentOperationById,
  synthesizeAgentOperationResource,
} from '../server/agent/budget';
import {
  findIdempotentIngestionOperation,
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
  idempotency?: { key?: string; inputDigest?: string },
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
    if (request.kind === 'agent') {
      const rows = await db
        .select({ status: learning_session.status })
        .from(learning_session)
        .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')))
        .limit(1);
      const status = rows[0]?.status;
      if (!status) throw new ApiError('not_found', `ingestion session ${sessionId} not found`, 404);

      if (status === 'uploaded' || status === 'failed') {
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
        // the dispatch transaction (grant + `queued` flip + send atomic).
        // A 429/503 rejection aborts the dispatch; the catch below records an
        // explicit operation.failed on the original handle.
        ({ jobId } = await Ingestion.enqueueAgentRun({
          db,
          boss,
          sessionId,
          operationId,
          beforeTransition: (tx) =>
            authorizeAgentRunStart(tx, {
              sessionId,
              operationId,
              idempotencyKey: idempotency?.key,
              inputDigest: idempotency?.inputDigest,
            }),
        }));
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
  // Replayed/reused handle currently attempting dispatch — a budget-gate
  // rejection must still land an explicit operation.failed on it (the brief:
  // accepted ops that cannot be paid get an honest terminal state).
  let replayedOperationId: string | undefined;
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
        replayedOperationId = existing.operationId;
        const resource = await ensureOperationDispatched(existing.operationId, sessionId, request, {
          key: idempotencyKey,
          inputDigest: hash,
        });
        return resourceResponse(resource, 200);
      }
      // YUK-1522 — durable 幂等权威：job_events 30 天清理后，agent op 的
      // key→handle 绑定仍在 learning_session.agent_budget（grant 持久，
      // 不随 TTL/回执裁剪消失）。命中同输入 → 原 handle；不同输入 → 409；
      // 旧无绑定证据的 grant → 不静默新发，fail closed。
      if (request.kind === 'agent') {
        const bound = await findAgentGrantByKeyDigest(db, {
          sessionId,
          keyDigest: agentKeyDigest(idempotencyKey),
        });
        if (bound) {
          if (bound.grant.input_digest !== hash) {
            throw new ApiError(
              'idempotency_conflict',
              `Idempotency-Key is already bound to operation ${bound.operationId}`,
              409,
            );
          }
          replayedOperationId = bound.operationId;
          const readable = await readIngestionOperation(db, bound.operationId);
          const resource = readable
            ? await ensureOperationDispatched(bound.operationId, sessionId, request, {
                key: idempotencyKey,
                inputDigest: hash,
              })
            : synthesizeAgentOperationResource(bound.operationId, sessionId, bound.grant);
          return resourceResponse(resource, 200);
        }
        if (await hasUnboundAgentGrants(db, sessionId)) {
          throw new ApiError(
            AGENT_BUDGET_UNAVAILABLE_CODE,
            '暂时无法确认录入助手的剩余额度，请稍后再试。',
            503,
            undefined,
            { reason: 'budget_read_unavailable' },
          );
        }
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
      replayedOperationId = reservation.operationId;
      const resource = await ensureOperationDispatched(
        reservation.operationId,
        sessionId,
        request,
        {
          key: idempotencyKey,
          inputDigest: hash,
        },
      );
      return resourceResponse(resource, 200);
    }
    createdOperationId = operationId;
    const resource = await ensureOperationDispatched(
      operationId,
      sessionId,
      request,
      { key: idempotencyKey, inputDigest: hash },
      () => {
        dispatched = true;
      },
    );
    return resourceResponse(resource, 202);
  } catch (err) {
    // 授权事务内命中 durable 绑定（并发首单抢跑或事件已 TTL 的重放）：
    // 重复创建的新 handle 显式终态化，返回原 handle（200），不二次付费。
    if (err instanceof AgentBudgetReplayError) {
      try {
        if (createdOperationId) {
          await writeIngestionOperationTerminalOnce(db, {
            operationId: createdOperationId,
            eventType: 'operation.failed',
            payload: {
              error: {
                code: 'idempotent_replay',
                message: `replayed to original operation ${err.operationId}`,
                status: 200,
              },
            },
          });
        }
        const original =
          (await readIngestionOperation(db, err.operationId)) ??
          (await readAgentOperationById(db, err.operationId));
        if (original) return resourceResponse(original, 200);
      } catch (replayErr) {
        console.error('failed to serve durable idempotent replay', replayErr);
      }
    }
    // boss 已接收 job 后，即使后续 queued-event/readback 短暂失败也不能把真实运行中的
    // operation 标成 failed；同 Idempotency-Key 重试会读回 accepted handle，worker/抽取
    // session 的后续事件继续推进资源快照。
    // Fresh reservations record operation.failed for any dispatch failure;
    // replayed handles only for budget-gate rejections (429/503) — transient
    // recovery errors must not permanently kill a still-dispatchable op.
    const pendingOperationId = createdOperationId ?? replayedOperationId;
    const isBudgetRejection =
      err instanceof ApiError &&
      (err.code === AGENT_BUDGET_EXCEEDED_CODE || err.code === AGENT_BUDGET_UNAVAILABLE_CODE);
    if (pendingOperationId && !dispatched && (createdOperationId != null || isBudgetRejection)) {
      try {
        await writeIngestionOperationTerminalOnce(db, {
          operationId: pendingOperationId,
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
    const resource =
      (await readIngestionOperation(db, operationId)) ??
      // YUK-1522 — agent op 的 durable readback：job_events 30 天清理后
      // 仍可从 learning_session.agent_budget 的 grant 合成真实终态。
      (await readAgentOperationById(db, operationId));
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
