// POST /api/copilot/chat durably accepts every conversation turn.
// Disconnects after acceptance only detach the client; the worker owns execution.

import { ZodError } from 'zod';
import { CopilotChatRequest } from '@/capabilities/copilot/server/chat-contracts';
import { writeCopilotReply } from '@/capabilities/copilot/server/conversation-writes';
import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
} from '@/capabilities/copilot/server/copilot-run-status';
import {
  MAX_OUTSTANDING_DURABLE_RUNS,
  countOutstandingDurableRuns,
} from '@/capabilities/copilot/server/durable-backlog';
import {
  COPILOT_IDEMPOTENCY_KEY_MAX_LENGTH,
  type CopilotDurableAcceptance,
  type ReserveCopilotDurableAcceptanceResult,
  dispatchSessionHead,
  findCopilotDurableAcceptance,
  hasTerminalCopilotRun,
  hashCopilotDurableInput,
  isCopilotSessionQueueRun,
  reconcileCopilotDurableAcceptance,
  reserveCopilotDurableAcceptance,
  withCopilotDurableDispatchLock,
} from '@/capabilities/copilot/server/durable-dispatch';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { fromPgBossDrizzleTx, getStartedBoss } from '@/server/boss/client';
import { writeJobEvent } from '@/server/events/writer';
import { checkRateLimit } from '@/server/http/rate-limit';
import { shouldEnqueueBackgroundJobs } from '@/server/runtime-env';

import { Conversation } from '@/server/session';

// Closes the count-then-enqueue race inside the single Hono API process. A slot
// moves from this counter into durable job_events once QUEUED is committed.
let durableDispatchReservations = 0;

function requestAbortedError(): ApiError {
  // 499 is the conventional server-side status for a client-closed request.
  // The caller is already gone; the important contract is that no new durable
  // side effect is committed after this guard observes the abort.
  return new ApiError('request_aborted', 'request aborted before acceptance', 499);
}

function assertRequestActive(signal: AbortSignal): void {
  if (signal.aborted) throw requestAbortedError();
}

type ParsedCopilotChatRequest = ReturnType<typeof CopilotChatRequest.parse>;

class CopilotDispatchAmbiguousError extends ApiError {
  constructor(cause: unknown) {
    super(
      'copilot_enqueue_ambiguous',
      'durable run acceptance or queue state could not be confirmed; retry with the same Idempotency-Key',
      503,
      { 'Retry-After': '1' },
    );
    this.cause = cause;
  }
}

class CopilotDispatchNotAcceptedError extends Error {
  constructor(cause: unknown) {
    super('durable run could not be enqueued', { cause });
    this.name = 'CopilotDispatchNotAcceptedError';
  }
}

function durableAcceptanceResponse(
  acceptance: CopilotDurableAcceptance,
  parsed: ParsedCopilotChatRequest,
): Response {
  return Response.json(
    {
      run_id: acceptance.runId,
      session_id: acceptance.sessionId,
      ...(parsed.triggered_by === 'chat' ? { checkpoint_event_id: acceptance.runId } : {}),
    },
    {
      status: 202,
      headers: {
        Location: `/api/jobs/copilot_run/${encodeURIComponent(acceptance.runId)}/events`,
      },
    },
  );
}

async function dispatchAcceptedRun(
  acceptance: CopilotDurableAcceptance,
  parsed: ParsedCopilotChatRequest,
): Promise<void> {
  try {
    if (await isCopilotSessionQueueRun(db, acceptance.runId)) {
      // v2 acceptance already committed its physical head job atomically. This
      // idempotent wake only matters for an accepted turn that was waiting when
      // a prior terminal settled between request attempts.
      await dispatchSessionHead(db, acceptance.sessionId, {
        boss: await getStartedBoss(),
        transactionDb: fromPgBossDrizzleTx,
      });
      return;
    }

    // Retained v1 acceptances did not persist a replayable worker job body or a
    // DISPATCHED marker. Keep their old exact-run recovery path during rollout.
    const outcome = await withCopilotDurableDispatchLock(db, acceptance.runId, async (tx) => {
      // A terminal replay is still the same accepted operation. Never recreate a
      // deleted pg-boss row after its durable public result already exists.
      if (await hasTerminalCopilotRun(tx, acceptance.runId)) {
        return { status: 'settled' as const };
      }

      const boss = await getStartedBoss();
      try {
        if (await boss.getJobById('copilot_run', acceptance.bossJobId)) {
          return { status: 'accepted' as const };
        }
      } catch (readErr) {
        // We have not sent anything in this attempt, but an earlier ambiguous
        // attempt may already own this stable id. Do not write a false FAILED.
        throw new CopilotDispatchAmbiguousError(readErr);
      }

      try {
        await boss.send(
          'copilot_run',
          {
            run_id: acceptance.runId,
            session_id: acceptance.sessionId,
            user_message: parsed.user_message,
            triggered_by: parsed.triggered_by,
            ...(parsed.chip_kind ? { chip_kind: parsed.chip_kind } : {}),
            ...(parsed.ambient_context ? { ambient: parsed.ambient_context } : {}),
            ...(parsed.correction_target_turn_id
              ? { correction_target_turn_id: parsed.correction_target_turn_id }
              : {}),
            ...(parsed.skill_context ? { skill_context: parsed.skill_context } : {}),
          },
          { id: acceptance.bossJobId },
        );
      } catch (sendErr) {
        // `send` may have committed and only lost its acknowledgement. Read back
        // the deterministic job id before deciding whether compensation is safe.
        try {
          if (await boss.getJobById('copilot_run', acceptance.bossJobId)) {
            return { status: 'accepted' as const };
          }
        } catch (readErr) {
          throw new CopilotDispatchAmbiguousError(readErr);
        }
        // A successful readback proving absence is the only path allowed to mark
        // this accepted turn enqueue_failed. The compensation MUST commit while
        // this same dispatch advisory lock is still held. Releasing the lock and
        // compensating in a second transaction would let a same-key contender
        // enqueue the stable job between those two critical sections, producing
        // a FAILED run whose worker is already executing.
        await writeJobEvent(tx, {
          business_table: COPILOT_RUN_TABLE,
          business_id: acceptance.runId,
          event_type: COPILOT_RUN_EVENTS.FAILED,
          payload: { reason: 'enqueue_failed', checkpoint_event_id: acceptance.runId },
        });
        await writeCopilotReply(tx, {
          sessionId: acceptance.sessionId,
          userAskEventId: acceptance.runId,
          replyText: 'run 未能受理（enqueue 失败）。请重试。',
          actorRef: 'agent:copilot',
          taskRunId: `copilot_run_enqueue_failed_${acceptance.runId}`,
          now: new Date(),
        });
        return { status: 'not_accepted' as const, cause: sendErr };
      }
      return { status: 'accepted' as const };
    });
    if (outcome.status === 'not_accepted') {
      throw new CopilotDispatchNotAcceptedError(outcome.cause);
    }
  } catch (err) {
    if (
      err instanceof CopilotDispatchAmbiguousError ||
      err instanceof CopilotDispatchNotAcceptedError
    ) {
      throw err;
    }
    // Includes advisory-lock/transaction settlement failures after a successful
    // send. Conservatively keep QUEUED; a same-key replay can disambiguate.
    throw new CopilotDispatchAmbiguousError(err);
  }
}

// 签名对齐 kernel RouteHandler 双参形（path 无参数段，_params 不用）。
export async function POST(req: Request, _params: Record<string, string>): Promise<Response> {
  // Validate before any durable side effect. HTTP owns acceptance, not execution.
  let parsed: ReturnType<typeof CopilotChatRequest.parse>;
  try {
    parsed = CopilotChatRequest.parse(await req.json());
  } catch (err) {
    // M5-T3 plan 钉测：schema 校验失败 → 400 validation_error JSON（plan Task 2
    // 单测 + curl 冒烟双钉）。旧栈裸 errorResponse(ZodError) 实回 500 —— 计划与
    // 现实冲突处以计划为准，对齐 practice/accept-chip 的 validation_error 形制。
    if (err instanceof ZodError) {
      return errorResponse(
        new ApiError('validation_error', err.issues.map((i) => i.message).join('; '), 400),
      );
    }
    return errorResponse(err);
  }
  if (req.signal.aborted) return errorResponse(requestAbortedError());

  const idempotencyKey = req.headers.get('Idempotency-Key')?.trim() || undefined;
  if (!idempotencyKey) {
    return errorResponse(new ApiError('validation_error', 'Idempotency-Key is required', 400));
  }
  if (idempotencyKey.length > COPILOT_IDEMPOTENCY_KEY_MAX_LENGTH) {
    return errorResponse(
      new ApiError(
        'validation_error',
        `Idempotency-Key must be at most ${COPILOT_IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
        400,
      ),
    );
  }
  const durableInputHash = hashCopilotDurableInput(parsed);

  // Replay accepted durable work before backlog/rate-limit/model triage. A
  if (idempotencyKey) {
    let accepted: CopilotDurableAcceptance | null = null;
    try {
      accepted = await findCopilotDurableAcceptance(db, idempotencyKey);
    } catch (findErr) {
      try {
        // A lost-202 recovery must never turn a transient read failure into a
        // generic 500 that tells the client to discard its stable key. Re-read
        // behind the reserve lock; this also waits out any in-flight COMMIT.
        accepted = await reconcileCopilotDurableAcceptance(db, idempotencyKey);
      } catch (reconcileErr) {
        return errorResponse(
          new CopilotDispatchAmbiguousError(
            new AggregateError(
              [findErr, reconcileErr],
              'durable replay lookup and locked reconciliation were both unavailable',
            ),
          ),
        );
      }
    }
    if (accepted && accepted.inputHash !== durableInputHash) {
      return errorResponse(
        new ApiError(
          'idempotency_conflict',
          `Idempotency-Key is already bound to durable run ${accepted.runId}`,
          409,
        ),
      );
    }
    if (accepted) {
      try {
        await dispatchAcceptedRun(accepted, parsed);
      } catch (err) {
        return errorResponse(err);
      }
      return durableAcceptanceResponse(accepted, parsed);
    }
  }

  // This flag disables queue writes in test environments; it is not a worker
  // health probe. Never fall back to request-owned execution.
  if (!shouldEnqueueBackgroundJobs()) {
    return errorResponse(new ApiError('copilot_queue_disabled', 'Copilot queue is disabled', 503));
  }
  let reservedDispatchSlot = false;
  try {
    assertRequestActive(req.signal);
    const outstanding = await countOutstandingDurableRuns(db);
    assertRequestActive(req.signal);
    if (outstanding + durableDispatchReservations >= MAX_OUTSTANDING_DURABLE_RUNS) {
      throw new ApiError(
        'copilot_backlog_full',
        `Copilot backlog is full (max ${MAX_OUTSTANDING_DURABLE_RUNS})`,
        429,
        { 'Retry-After': '30' },
      );
    }
    durableDispatchReservations++;
    reservedDispatchSlot = true;
    checkRateLimit();
    assertRequestActive(req.signal);

    // 1) 复用 inline 同一会话信封——durable run 的 user_ask / 回复事件共享 session_id。
    const conv = await Conversation.findOrCreateCopilotConversation(db, {
      sessionId: parsed.session_id,
    });
    assertRequestActive(req.signal);
    // 2) One transaction reserves the stable handle and commits user_ask +
    // QUEUED together. Same key + same normalized input reuses that handle;
    // a changed input is an explicit 409 rather than a second paid run.
    let reservation: ReserveCopilotDurableAcceptanceResult;
    try {
      reservation = await reserveCopilotDurableAcceptance(
        db,
        {
          sessionId: conv.sessionId,
          userMessage: parsed.user_message,
          inputHash: durableInputHash,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          queuedPayload: {
            session_id: conv.sessionId,
            triggered_by: parsed.triggered_by,
            dispatch: { source: 'unified_conversation' },
          },
          jobData: {
            user_message: parsed.user_message,
            triggered_by: parsed.triggered_by,
            ...(parsed.chip_kind ? { chip_kind: parsed.chip_kind } : {}),
            ...(parsed.ambient_context ? { ambient: parsed.ambient_context } : {}),
            ...(parsed.correction_target_turn_id
              ? { correction_target_turn_id: parsed.correction_target_turn_id }
              : {}),
            ...(parsed.skill_context ? { skill_context: parsed.skill_context } : {}),
          },
          assertActive: () => assertRequestActive(req.signal),
        },
        {
          boss: await getStartedBoss(),
          transactionDb: fromPgBossDrizzleTx,
        },
      );
    } catch (reserveErr) {
      if (!idempotencyKey) throw reserveErr;
      let reconciled: CopilotDurableAcceptance | null;
      try {
        // A rejected COMMIT is not proof of rollback. Wait behind the exact
        // idempotency lock used by reserve, then read the deterministic run:
        // this cannot race ahead of a server-side late COMMIT.
        reconciled = await reconcileCopilotDurableAcceptance(db, idempotencyKey);
      } catch (reconcileErr) {
        throw new CopilotDispatchAmbiguousError(
          new AggregateError(
            [reserveErr, reconcileErr],
            'durable acceptance commit and locked reconciliation were both unavailable',
          ),
        );
      }
      // A successful locked null read proves that the failed transaction did
      // not commit. Preserve its original (possibly 499) definitive error.
      if (!reconciled) throw reserveErr;
      reservation = {
        outcome: reconciled.inputHash === durableInputHash ? 'reused' : 'conflict',
        acceptance: reconciled,
      };
    }
    if (reservation.outcome === 'conflict') {
      throw new ApiError(
        'idempotency_conflict',
        `Idempotency-Key is already bound to durable run ${reservation.acceptance.runId}`,
        409,
      );
    }
    const acceptance = reservation.acceptance;
    // ask + QUEUED is now committed: this is the server-side acceptance
    // boundary. If this turn was the session head, its physical job and
    // DISPATCHED marker committed in that same transaction; otherwise its
    // complete job_data remains accepted for a later terminal wake.
    // 3) 幂等唤醒当前 session head。run 在 worker 进程跑、进度落 job_events、SSE 经泛化
    //    GET /api/jobs/copilot_run/[run_id]/events（YUK-310 caller-agnostic 路由，
    //    copilot_run 已在其 allowlist）重连；dock 消费端由 YUK-596（PR2）接。
    //    ambient/chip/correction/skill context 随 QUEUED job_data 持久化，等待 turn
    //    被推进时无需客户端重发；conversation_history / learner-state 仍从事件重建。
    await dispatchAcceptedRun(acceptance, parsed);
    return durableAcceptanceResponse(acceptance, parsed);
  } catch (err) {
    // Session-queue v2 acceptance and physical head dispatch roll back
    // together. dispatchAcceptedRun retains the old compensation/readback
    // protocol only for legacy acceptances encountered during rollout.
    // enqueue 链路任一步失败 → 普通 JSON error（绝不开半截 SSE 流）。run 未受理。
    return errorResponse(err);
  } finally {
    if (reservedDispatchSlot) durableDispatchReservations--;
  }
}
