import { createId } from '@paralleldrive/cuid2';
import { canonicalHash } from '@/core/migration/canonical';
import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { fromPgBossDrizzleTx, getStartedBoss } from '@/server/boss/client';
import { writeJobEvent } from '@/server/events/writer';
import type { CopilotChatRequestT } from './chat-contracts';
import { writeCopilotReply } from './conversation-writes';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from './copilot-run-status';
import type { CrisisTurnClassification } from './crisis-guard';
import {
  type CopilotDurableAcceptance,
  type ReserveCopilotDurableAcceptanceResult,
  dispatchSessionHead,
  findCopilotDurableAcceptance,
  hasTerminalCopilotRun,
  isCopilotSessionQueueRun,
  reconcileCopilotDurableAcceptance,
  reserveCopilotDurableAcceptance,
  withCopilotDurableDispatchLock,
} from './durable-dispatch';

export type AcceptedCopilotTurn = Pick<
  CopilotDurableAcceptance,
  'runId' | 'sessionId' | 'derivationPolicy'
>;

export function requestAbortedError(): ApiError {
  // 499 is the conventional server-side status for a client-closed request. The
  // contract: no new durable side effect may commit after this guard observes
  // the abort.
  return new ApiError('request_aborted', 'request aborted before acceptance', 499);
}

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

async function dispatchAcceptedRun(
  db: Db,
  acceptance: CopilotDurableAcceptance,
  parsed: CopilotChatRequestT,
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

    // Retained v1 acceptances persisted no replayable worker job body or
    // DISPATCHED marker; keep their exact-run recovery path.
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
            derivation_policy: acceptance.derivationPolicy ?? 'allow',
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
        // this same dispatch advisory lock is held: releasing it and compensating
        // in a second transaction would let a same-key contender enqueue the
        // stable job between those two critical sections, producing a FAILED run
        // whose worker is already executing.
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

/** Recover accepted work before the caller applies new-request admission gates. */
export async function recoverAcceptedCopilotTurn(
  db: Db,
  input: { key: string; parsed: CopilotChatRequestT; inputHash: string },
): Promise<AcceptedCopilotTurn | null> {
  const { key: idempotencyKey, parsed, inputHash: durableInputHash } = input;
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
      throw new CopilotDispatchAmbiguousError(
        new AggregateError(
          [findErr, reconcileErr],
          'durable replay lookup and locked reconciliation were both unavailable',
        ),
      );
    }
  }
  if (accepted && accepted.inputHash !== durableInputHash) {
    throw new ApiError(
      'idempotency_conflict',
      `Idempotency-Key is already bound to durable run ${accepted.runId}`,
      409,
    );
  }
  if (accepted) {
    await dispatchAcceptedRun(db, accepted, parsed);
  }
  return accepted;
}

/** Accept an admitted turn and recover any ambiguous acceptance or dispatch result. */
export async function acceptCopilotTurnAfterAdmission(
  db: Db,
  input: {
    key: string;
    parsed: CopilotChatRequestT;
    inputHash: string;
    sessionId: string;
    crisis: CrisisTurnClassification;
    droppedReviewAnswer: boolean;
    signal: AbortSignal;
  },
): Promise<AcceptedCopilotTurn> {
  const {
    key: idempotencyKey,
    parsed,
    inputHash: durableInputHash,
    sessionId,
    crisis,
    droppedReviewAnswer,
    signal,
  } = input;
  const acceptedDerivationPolicy =
    crisis.forcedPolicy ?? parsed.derivation_policy ?? ('allow' as const);
  let reservation: ReserveCopilotDurableAcceptanceResult;
  try {
    reservation = await reserveCopilotDurableAcceptance(
      db,
      {
        sessionId,
        userMessage: parsed.user_message,
        reviewAnswer: parsed.review_answer,
        inputHash: durableInputHash,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        queuedPayload: {
          session_id: sessionId,
          ...(parsed.review_answer
            ? { review_answer_sha256: canonicalHash(parsed.review_answer) }
            : {}),
          triggered_by: parsed.triggered_by,
          dispatch: { source: 'unified_conversation' },
        },
        jobData: {
          user_message: parsed.user_message,
          derivation_policy: acceptedDerivationPolicy,
          triggered_by: parsed.triggered_by,
          ...(parsed.chip_kind ? { chip_kind: parsed.chip_kind } : {}),
          ...(parsed.ambient_context ? { ambient: parsed.ambient_context } : {}),
          ...(parsed.correction_target_turn_id
            ? { correction_target_turn_id: parsed.correction_target_turn_id }
            : {}),
          ...(parsed.skill_context ? { skill_context: parsed.skill_context } : {}),
        },
        ...(crisis.forcedPolicy
          ? {
              crisisGuard: {
                sessionId,
                detectionClass: crisis.detectionClass as Exclude<
                  typeof crisis.detectionClass,
                  'none'
                >,
                entryPoint:
                  parsed.triggered_by === 'chip'
                    ? ('copilot_chip' as const)
                    : ('copilot_chat' as const),
                eventId: `crisis_guard_${createId()}`,
                now: new Date(),
                // 被剔除的附件只记类型，不记内容。
                ...(droppedReviewAnswer ? { droppedAttachmentKind: 'review_answer' as const } : {}),
              },
            }
          : {}),
        assertActive: () => {
          if (signal.aborted) throw requestAbortedError();
        },
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
  // ask + QUEUED is now committed: the server-side acceptance boundary. If this
  // turn was the session head, its physical job and DISPATCHED marker committed
  // in that same transaction; otherwise its complete job_data remains accepted
  // for a later terminal wake.
  // 3) 幂等唤醒当前 session head。ambient/chip/correction/skill context 随 QUEUED
  //    job_data 持久化，等待 turn 被推进时无需客户端重发；conversation_history /
  //    learner-state 仍从事件重建。
  await dispatchAcceptedRun(db, acceptance, parsed);
  return acceptance;
}
