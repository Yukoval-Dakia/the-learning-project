import { eq, sql } from 'drizzle-orm';

import type { DerivationPolicyT } from '@/core/schema/derivation-policy';
import type { Db, Tx } from '@/db/client';
import { source_document } from '@/db/schema';
import { resolveSessionDerivationPolicy } from '@/kernel/read-models/usage-policy';
import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/kernel/tools/allowlists';
import {
  AgentRunError,
  isProviderSessionWallClockBudgetError,
  isTransientAgentFailure,
} from '@/server/ai/agent-run-error';
import { ProviderAttemptLifecycleError } from '@/server/ai/provider-attempt-lifecycle';
import { ProviderSessionAdmissionError } from '@/server/ai/provider-session-admission';
// NOTE: the failure-vocabulary modules are imported from their own files, not
// runner-fn — re-exporting them there pulls providers→task-catalog→schema into
// runner-fn's cone and breaks vitest module order (db/schema ↔ generated).
import { type BoundRunTaskFn, makeRunTaskFn } from '@/server/ai/runner-fn';
import { piDomainMount } from '@/server/ai/tools/pi-tools';
import { Ingestion } from '@/server/session';
import {
  writeAgentErrorEvent,
  writeAgentItemEvent,
  writeAgentPaidAttempt,
  writeAgentRunSegment,
  writeAgentStageEvent,
} from '../events/agent-progress';
import { writeIngestionUsageReceipt } from '../privacy-guard';
import { readSourcePackage } from '../source-package';
import {
  type AgentRedactionSink,
  attachAgentRedactionSink,
  detachAgentRedactionSink,
} from '../tools/redaction-sink';
import { listExpiredOpenAsks, readSessionAsks, resolveAskByTimeout } from './asks';
import {
  agentRunTaskRunId,
  agentToolRunId,
  recordAgentOperationRunning,
  settleAgentRunBudget,
} from './budget';
import type { IngestionAgentErrorCodeT, IngestionAgentStageCountsT } from './contract';
import { enqueueAgentContinuation } from './dispatch';
import {
  type AgentRunLedger,
  claimRunSegment,
  isTerminalItemStatus,
  readAgentRunLedger,
  terminalItemCounts,
} from './ledger';
import {
  enterAgentExecution,
  recordAgentExecutionIntent,
  requireAgentExecutionOwner,
} from './ownership';
import { agentInterceptInput, buildAgentSegmentInput } from './run-input';
import { retainAgentTaskLiability } from './spend';

// YUK-1522 (R8) — ingestion agent run orchestrator.
//
// One durable run per ingestion session over the WHOLE source package, built
// from segments: the pg-boss job calls this once per delivery. A segment is a
// single IngestionAgentTask execution — the model drives
// read_source/view_image/crop/rotate/glm_ocr + edit_question/compose_presentation
// /submit_question + the two R8 tools (report_ingestion_progress, ask_learner).
//
// Durability lives in job_events, not in a blocked worker:
//   - progress + asks are written inside the same tx as tool side-effects;
//   - a segment that ends with open asks exits 'waiting' — the answer/timeout
//     lane resolves the ask, marks resume_requested and enqueues the next
//     segment, which rebuilds context from this ledger (no transcript replay);
//   - a segment that ends early without asks self-continues (bounded by
//     MAX_SEGMENTS) so a premature model yield never strands the run;
//   - bookkeeping AFTER the paid model call is isolated: a crash there leaves
//     the segment 'running' until the stale-segment sweeper terminally settles
//     it — the paid call is never re-run for a ledger fault.
//
// Session status reuses the extraction state machine (queued→extracting→
// extracted|partial|failed); asks leave the session honestly 'extracting'.

const SEGMENT_TIMEOUT_MS = 20 * 60_000;
const SEGMENT_MAX_ITERATIONS = 120;
const MAX_SEGMENTS = 8;

export interface RunAgentSegmentParams {
  readonly sessionId: string;
  readonly trigger: 'start' | 'resume' | 'continue';
  readonly operationId?: string;
  readonly runRef?: string;
  /** pg-boss delivery metadata; retries cannot bypass the durable claim. */
  readonly retryCount?: number;
}

export interface AgentRunOutcome {
  readonly outcome: 'done' | 'waiting' | 'continue' | 'skipped' | 'failed';
  readonly status?: string;
  readonly segment?: number;
  readonly open_asks?: readonly string[];
  readonly terminal_items?: number;
  readonly failed_items?: number;
  readonly error?: string;
}

export interface AgentRunDeps {
  readonly runTaskFn?: BoundRunTaskFn;
  /** Verification seam: throw AFTER the paid call returns, before bookkeeping. */
  readonly throwBeforeBookkeeping?: () => void;
  /** Verification seam: throw after the claim, before the paid call. */
  readonly throwBeforeModel?: () => void;
  /** Verification seam: replace the continuation send (R2-4 failure-path test). */
  readonly enqueueContinuation?: (sessionId: string, intentId: number) => Promise<unknown>;
}

async function sweepExpiredAsksForSession(db: Db, sessionId: string): Promise<void> {
  // Inline safety net: the cron sweeper owns timeout resolution globally, but a
  // segment starting now should not run with stale expired asks.
  const expired = await listExpiredOpenAsks(db, 20);
  const asks = await readSessionAsks(db, sessionId);
  const sessionOpen = new Set(asks.filter((a) => a.resolved == null).map((a) => a.ask_id));
  for (const askId of expired) {
    if (!sessionOpen.has(askId)) continue;
    await resolveAskByTimeout(db, askId).catch((err) =>
      console.error('[ingestion-agent] inline ask timeout sweep failed', { askId, error: err }),
    );
  }
}

/**
 * P2 (R1) — classify by error type, never by message text. A DB or ledger
 * fault thrown out of the model call path must not masquerade as a retryable
 * model outage; unknown paid outcomes stay permanent by default.
 */
function classifyRunFailure(err: unknown): { code: IngestionAgentErrorCodeT; retryable: boolean } {
  if (err instanceof AgentRunError) {
    if (
      err.subtype === 'budget_timeout' ||
      err.subtype === 'error_max_budget_usd' ||
      err.subtype === 'error_max_turns'
    ) {
      return { code: 'budget_exhausted', retryable: false };
    }
    if (isTransientAgentFailure(err)) return { code: 'model_unavailable', retryable: true };
    // Permanent API/config error or CLI-internal execution error.
    return { code: 'model_unavailable', retryable: false };
  }
  if (isProviderSessionWallClockBudgetError(err)) {
    return { code: 'budget_exhausted', retryable: false };
  }
  if (err instanceof ProviderSessionAdmissionError) {
    return { code: 'model_unavailable', retryable: true };
  }
  // ProviderAttemptLifecycleError = unknown paid outcome — never blind-retry.
  if (err instanceof ProviderAttemptLifecycleError) {
    return { code: 'worker_lost', retryable: false };
  }
  return { code: 'worker_lost', retryable: false };
}

const EMPTY_SINK: AgentRedactionSink = {
  fields: new Set(),
  counts: {},
  countedKeys: new Set(),
  cache: new Map(),
};

async function writeRunReceipt(
  tx: Tx,
  sessionId: string,
  sourceDocumentId: string | null,
  derivationPolicy: DerivationPolicyT,
  sink: AgentRedactionSink,
  segment?: number,
): Promise<void> {
  if (sourceDocumentId == null) return;
  await writeIngestionUsageReceipt(tx, {
    sourceDocumentId,
    sessionId,
    derivationPolicy,
    engine: 'ingestion_agent',
    channels: { page_images: 'raw', extracted_text: 'redacted' },
    redactedFields: [...sink.fields],
    redactionCounts: sink.counts,
    ...(segment !== undefined ? { segment } : {}),
  });
}

/** Contract counts from the item ledger — the only writer for stage.counts keys. */
function contractCounts(ledger: AgentRunLedger): IngestionAgentStageCountsT {
  const failed = ledger.items.filter((item) => item.status === 'failed').length;
  const withheld = ledger.items.filter((item) => item.status === 'withheld').length;
  const done = ledger.items.filter(
    (item) => item.status === 'admitted' || item.status === 'withheld',
  ).length;
  return {
    items_total: ledger.items.length,
    items_done: done,
    items_withheld: withheld,
    items_failed: failed,
  };
}

export async function runIngestionAgentSegment(
  db: Db,
  params: RunAgentSegmentParams,
  deps: AgentRunDeps = {},
): Promise<AgentRunOutcome> {
  const { sessionId, trigger } = params;
  const runTask = deps.runTaskFn ?? makeRunTaskFn(db);

  // Ownership, queued transition and claim share one run lock and row lock.
  // A stale job cannot consume a later operation's queued transition/runRef.
  const entry = await db.transaction(async (tx) => {
    const entered = await enterAgentExecution(tx, params);
    if (!entered) return null;
    if (entered.status === 'queued') await Ingestion.markExtractionStarted(tx, sessionId);
    const claim = await claimRunSegment(tx, sessionId, trigger, MAX_SEGMENTS);
    return { session: entered, claim };
  });
  if (!entry) return { outcome: 'skipped', status: 'execution_not_owned' };
  const { session, claim } = entry;
  const runRef = session.owner.run_ref;
  // All terminal writes use this frozen owner, including legacy resumptions.
  params = { ...params, operationId: session.owner.operation_id ?? undefined, runRef };
  if (claim.kind === 'busy') {
    return { outcome: 'skipped', status: 'segment_in_flight' };
  }
  if (claim.kind === 'settlement_pending') {
    await failSessionForUnknownPaidAttempt(db, sessionId, claim.segment, {
      markerId: claim.markerId,
      operationId: params.operationId,
      runRef,
    });
    return { outcome: 'failed', status: 'terminal_settlement_recovered', segment: claim.segment };
  }
  await sweepExpiredAsksForSession(db, sessionId);
  if (claim.kind === 'over_cap') {
    // MAX_SEGMENTS — mark every non-terminal item failed (worker_lost) so the
    // completion counts are honest, then complete + receipt (paid work did run).
    const ledger = claim.ledger;
    const prior = terminalItemCounts(ledger.items);
    const stranded = ledger.items.filter((item) => !isTerminalItemStatus(item.status));
    await db.transaction(async (tx) => {
      await requireAgentExecutionOwner(tx, sessionId, runRef);
      for (const item of stranded) {
        await writeAgentItemEvent(tx, sessionId, {
          kind: 'ingestion_agent.item',
          item_id: item.item_id,
          question_no: item.question_no,
          status: 'failed',
          reason: 'worker_lost: segment cap reached',
          ...(item.page !== undefined ? { page: item.page } : {}),
        });
      }
      const done = await Ingestion.markAgentRunCompleted(tx, {
        sessionId,
        completion: {
          items_terminal: ledger.items.length,
          items_failed: prior.items_failed + stranded.length,
        },
      });
      await settleAgentRunBudget(tx, {
        sessionId,
        operationId: params.operationId,
        terminal: done.status === 'failed' ? 'failed' : 'completed',
        ...(done.status === 'failed'
          ? { error: { code: 'worker_lost', reason: 'segment_cap' } }
          : { result: { session_status: done.status } }),
      });
      await writeRunReceipt(
        tx,
        sessionId,
        session.source_document_id,
        await resolveSessionDerivationPolicy(tx, sessionId),
        EMPTY_SINK,
      );
      await writeAgentRunSegment(tx, sessionId, {
        segment: claim.segment,
        trigger,
        outcome: 'done',
      });
      await writeAgentErrorEvent(tx, sessionId, {
        kind: 'ingestion_agent.error',
        scope: 'session',
        code: 'worker_lost',
        retryable: false,
      });
      return done;
    });
    return {
      outcome: 'done',
      status: 'failed',
      terminal_items: ledger.items.length,
      failed_items: prior.items_failed + stranded.length,
    };
  }

  const segment = claim.segment;
  const ledger = claim.ledger;
  const openAskIds = ledger.openAsks.map((ask) => ask.ask_id);

  // P1-5.2 — free gates run BEFORE the paid model call.
  if (openAskIds.length > 0) {
    await db.transaction(async (tx) => {
      await requireAgentExecutionOwner(tx, sessionId, runRef);
      await writeAgentRunSegment(tx, sessionId, {
        segment,
        trigger,
        outcome: 'waiting',
        open_asks: openAskIds,
      });
    });
    return { outcome: 'waiting', open_asks: openAskIds, segment };
  }
  const allTerminal =
    ledger.items.length > 0 && ledger.items.every((item) => isTerminalItemStatus(item.status));
  if (ledger.doneEmitted || allTerminal) {
    return finalizeRun(db, sessionId, session.source_document_id, ledger, segment, trigger, runRef);
  }

  // R2-6 — a pending terminal request (e.g. from a crashed post-model pass)
  // owns the session error; the run fails before any new paid call.
  if (ledger.terminalRequest != null) {
    await db.transaction(async (tx) => {
      await requireAgentExecutionOwner(tx, sessionId, runRef);
      await writeAgentRunSegment(tx, sessionId, { segment, trigger, outcome: 'failed' });
      await writeAgentErrorEvent(tx, sessionId, {
        kind: 'ingestion_agent.error',
        scope: 'session',
        code: ledger.terminalRequest!.code as IngestionAgentErrorCodeT,
        retryable: false,
      });
      await Ingestion.markExtractionFailed(
        tx,
        sessionId,
        `agent reported the package terminal (${ledger.terminalRequest!.code})`,
      );
      await settleAgentRunBudget(tx, {
        sessionId,
        operationId: params.operationId,
        terminal: 'failed',
        error: { code: ledger.terminalRequest!.code },
      });
    });
    return { outcome: 'failed', error: `terminal_request ${ledger.terminalRequest.code}` };
  }

  const derivationPolicy = await resolveSessionDerivationPolicy(db, sessionId);

  // derivation_policy: the shared tool bridge denies every needed tool under
  // 'answer_only'/'crisis' — refuse the paid run honestly at entry rather than
  // burning a doomed segment. R2-8: the contract error is emitted too (the
  // endpoint's 422 is the first line; this is the backstop).
  if (derivationPolicy !== 'allow') {
    await db.transaction(async (tx) => {
      await requireAgentExecutionOwner(tx, sessionId, runRef);
      await writeAgentRunSegment(tx, sessionId, { segment, trigger, outcome: 'failed' });
      await writeAgentErrorEvent(tx, sessionId, {
        kind: 'ingestion_agent.error',
        scope: 'session',
        code: 'policy_blocked',
        retryable: false,
      });
      await writeRunReceipt(
        tx,
        sessionId,
        session.source_document_id,
        derivationPolicy,
        EMPTY_SINK,
        segment,
      );
      await Ingestion.markExtractionFailed(
        tx,
        sessionId,
        `usage policy '${derivationPolicy}' does not permit bank ingestion`,
      );
      await settleAgentRunBudget(tx, {
        sessionId,
        operationId: params.operationId,
        terminal: 'failed',
        error: { code: 'policy_blocked', policy: derivationPolicy },
      });
    });
    return { outcome: 'failed', error: `derivation_policy ${derivationPolicy}` };
  }

  let packageSummary: { kind: string | null; page_count: number } = {
    kind: null,
    page_count: 0,
  };
  if (session.source_document_id != null) {
    const [doc] = await db
      .select({ provenance: source_document.provenance })
      .from(source_document)
      .where(eq(source_document.id, session.source_document_id))
      .limit(1);
    const pkg = readSourcePackage(doc?.provenance);
    packageSummary = { kind: pkg?.kind ?? null, page_count: pkg?.pages.length ?? 0 };
  }

  const providerDeadline = Date.now() + SEGMENT_TIMEOUT_MS;
  // YUK-1522 — 本次授权的稳定身份 = in_flight grant 的 operation_id（预授权时代
  // run 无 grant → 退化 sessionId）。resume/continue 取回同一 runRef；
  // task/tool run id 由 (runRef, segment) 确定性派生，GLM OCR anchor 归属同一次启动。
  const toolCtx = {
    db,
    taskRunId: agentToolRunId(runRef, segment),
    providerAttemptCaller: 'worker' as const,
    providerSessionDeadlineAt: providerDeadline,
    callerActor: { kind: 'agent' as const, ref: `ingestion_agent:${sessionId}` },
    scope: { kind: 'ingestion_session', id: sessionId },
    derivationPolicy,
  };
  const redactionSink: AgentRedactionSink = attachAgentRedactionSink(sessionId);
  try {
    const mount = piDomainMount({
      ctx: toolCtx,
      serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
      toolNames: resolveDomainToolNames('ingestion'),
      taskKind: 'IngestionAgentTask',
      interceptInput: agentInterceptInput(sessionId),
    });

    const input = buildAgentSegmentInput({
      sessionId,
      documentId: session.source_document_id,
      packageSummary,
      derivationPolicy,
      ledger,
      segment,
      trigger,
      toolCtx,
    });

    let taskRunId: string | undefined;
    deps.throwBeforeModel?.();
    // R2-5 — durable paid-attempt identity BEFORE the call: a stale 'running'
    // segment with a 'sent' marker can never be auto re-paid (outcome unknown).
    const attemptRef = `r8:${sessionId}:seg:${segment}`;
    try {
      if (segment === 1) {
        // YUK-1522/G6 — operation handle queued → running（投影取最新事件，
        // 重放幂等）。只在首个付费 segment 起步时写一次。
        await db.transaction(async (tx) => {
          await requireAgentExecutionOwner(tx, sessionId, runRef);
          await recordAgentOperationRunning(tx, {
            sessionId,
            operationId: params.operationId,
          });
        });
      }
      await retainAgentTaskLiability(db, sessionId, agentRunTaskRunId(runRef, segment));
      await writeAgentPaidAttempt(db, sessionId, {
        segment,
        attempt_ref: attemptRef,
        phase: 'sent',
      });
      const result = await runTask('IngestionAgentTask', input, {
        piToolMounts: [mount],
        allowedTools: [...resolveMcpAllowedTools('ingestion')],
        budgetOverride: { maxIterations: SEGMENT_MAX_ITERATIONS, timeoutMs: SEGMENT_TIMEOUT_MS },
        providerSessionDeadlineAt: providerDeadline,
        // YUK-1522 — caller-owned deterministic task_run_id（segment 级），
        // 主 run 的 cost_ledger 行由此锚定到本次授权。
        taskRunId: agentRunTaskRunId(runRef, segment),
      });
      taskRunId = result.task_run_id;
      await writeAgentPaidAttempt(db, sessionId, {
        segment,
        attempt_ref: attemptRef,
        phase: 'settled',
        ...(taskRunId != null ? { task_run_id: taskRunId } : {}),
      });
    } catch (err) {
      const { code, retryable } = classifyRunFailure(err);
      const message = err instanceof Error ? err.message : String(err);
      // Paid work happened — the receipt is written on failure paths too.
      await db
        .transaction(async (tx) => {
          await requireAgentExecutionOwner(tx, sessionId, runRef);
          await writeAgentErrorEvent(tx, sessionId, {
            kind: 'ingestion_agent.error',
            scope: 'session',
            code,
            retryable,
          });
          await writeAgentRunSegment(tx, sessionId, {
            segment,
            trigger,
            outcome: 'failed',
            ...(taskRunId != null ? { task_run_id: taskRunId } : {}),
          });

          await writeRunReceipt(
            tx,
            sessionId,
            session.source_document_id,
            derivationPolicy,
            redactionSink,
            segment,
          );
          await Ingestion.markExtractionFailed(tx, sessionId, message.slice(0, 500));
          await settleAgentRunBudget(tx, {
            sessionId,
            operationId: params.operationId,
            terminal: 'failed',
            error: { code },
          });
        })
        .catch((secondary) =>
          console.error(
            '[ingestion-agent] terminal transaction rolled back; running segment retained for sweep',
            {
              session_id: sessionId,
              error: secondary,
            },
          ),
        );
      return { outcome: 'failed', error: message.slice(0, 500) };
    }

    // P1-5.3 — bookkeeping after the paid call is isolated: a throw here logs,
    // leaves the segment 'running' for the stale-segment sweeper to close, and
    // returns normally so pg-boss never retries the whole PAID segment.
    try {
      deps.throwBeforeBookkeeping?.();
      const after = await readAgentRunLedger(db, sessionId);

      // R2-6 — a model-declared terminal request becomes the session error and
      // stops the run; it can never coexist with further progress (the tool
      // itself refuses writes after recording the request).
      if (after.terminalRequest != null) {
        await db.transaction(async (tx) => {
          await requireAgentExecutionOwner(tx, sessionId, runRef);
          await writeAgentRunSegment(tx, sessionId, {
            segment,
            trigger,
            outcome: 'failed',
            ...(taskRunId != null ? { task_run_id: taskRunId } : {}),
          });
          await writeAgentErrorEvent(tx, sessionId, {
            kind: 'ingestion_agent.error',
            scope: 'session',
            code: after.terminalRequest!.code as IngestionAgentErrorCodeT,
            retryable: false,
          });
          await writeRunReceipt(
            tx,
            sessionId,
            session.source_document_id,
            derivationPolicy,
            redactionSink,
            segment,
          );
          await Ingestion.markExtractionFailed(
            tx,
            sessionId,
            `agent reported the package terminal (${after.terminalRequest!.code})`,
          );
          await settleAgentRunBudget(tx, {
            sessionId,
            operationId: params.operationId,
            terminal: 'failed',
            error: { code: after.terminalRequest!.code },
          });
        });
        return {
          outcome: 'failed',
          segment,
          error: `terminal_request ${after.terminalRequest.code}`,
        };
      }

      const afterOpen = after.openAsks.map((ask) => ask.ask_id);

      if (afterOpen.length > 0) {
        // Per-segment usage receipt: the paid call + this segment's redactions
        // are usage even though the run is suspended.
        await db.transaction(async (tx) => {
          await requireAgentExecutionOwner(tx, sessionId, runRef);
          await writeAgentRunSegment(tx, sessionId, {
            segment,
            trigger,
            outcome: 'waiting',
            open_asks: afterOpen,
            ...(taskRunId != null ? { task_run_id: taskRunId } : {}),
          });
          await writeRunReceipt(
            tx,
            sessionId,
            session.source_document_id,
            derivationPolicy,
            redactionSink,
            segment,
          );
        });
        return { outcome: 'waiting', open_asks: afterOpen, segment };
      }

      const afterAllTerminal =
        after.items.length > 0 && after.items.every((item) => isTerminalItemStatus(item.status));
      if (after.doneEmitted || afterAllTerminal) {
        // Contract completeness: the agent emits done on a clean finish; when the
        // ledger proves completion anyway, the orchestrator backfills it.
        const result = await db.transaction(async (tx) => {
          await requireAgentExecutionOwner(tx, sessionId, runRef);
          if (!after.doneEmitted) {
            await writeAgentStageEvent(tx, sessionId, {
              kind: 'ingestion_agent.stage',
              stage: 'done',
              counts: contractCounts(after),
            });
          }
          const completed = await Ingestion.markAgentRunCompleted(tx, {
            sessionId,
            completion: terminalItemCounts(after.items),
          });
          await settleAgentRunBudget(tx, {
            sessionId,
            operationId: params.operationId,
            terminal: completed.status === 'failed' ? 'failed' : 'completed',
            result: { session_status: completed.status },
          });
          await writeRunReceipt(
            tx,
            sessionId,
            session.source_document_id,
            derivationPolicy,
            redactionSink,
            segment,
          );
          await writeAgentRunSegment(tx, sessionId, {
            segment,
            trigger,
            outcome: 'done',
            ...(taskRunId != null ? { task_run_id: taskRunId } : {}),
          });
          return completed;
        });
        const doneCounts = terminalItemCounts(after.items);
        return {
          outcome: 'done',
          status: result.status,
          segment,
          terminal_items: doneCounts.items_terminal,
          failed_items: doneCounts.items_failed,
        };
      }

      // P1-4 — early exit with no open asks and unfinished items: internal
      // bookkeeping only (early_exit marker), never a session-scope error.
      // R2-4 — the continuation intent is durable and written in the SAME tx as
      // the close: a failed enqueue is recovered by the sweeper's
      // continue_requested scan, which re-sends with the same per-intent id.
      const markerId = await db.transaction(async (tx) => {
        await requireAgentExecutionOwner(tx, sessionId, runRef);
        await writeAgentRunSegment(tx, sessionId, {
          segment,
          trigger,
          outcome: 'early_exit',
          ...(taskRunId != null ? { task_run_id: taskRunId } : {}),
        });
        const continueMarkerId = await recordAgentExecutionIntent(tx, sessionId, 'continue');
        await writeRunReceipt(
          tx,
          sessionId,
          session.source_document_id,
          derivationPolicy,
          redactionSink,
          segment,
        );
        return continueMarkerId;
      });
      const enqueueContinuation = deps.enqueueContinuation ?? enqueueAgentContinuation;
      await enqueueContinuation(sessionId, markerId).catch((err) =>
        console.error('[ingestion-agent] continuation enqueue failed (sweeper will recover)', {
          session_id: sessionId,
          error: err,
        }),
      );
      return { outcome: 'continue', segment };
    } catch (bookkeepingErr) {
      console.error('[ingestion-agent] post-model bookkeeping failed — segment left for sweep', {
        session_id: sessionId,
        segment,
        task_run_id: taskRunId,
        error: bookkeepingErr,
      });
      return {
        outcome: 'failed',
        segment,
        error: 'post_model_bookkeeping',
      };
    }
  } finally {
    detachAgentRedactionSink(sessionId);
  }
}

/**
 * Live recovery for stale running and old failed-before-settle markers. The
 * marker/run identity is rechecked under the same locks as worker entry. A
 * rollback leaves it selectable; a commit is terminal without a model call.
 * Neither a timeout nor a missing paid marker proves the old executor closed.
 */
export async function failSessionForUnknownPaidAttempt(
  db: Db,
  sessionId: string,
  segment: number,
  identity: { markerId: number; operationId?: string; runRef?: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const entry = await enterAgentExecution(tx, {
      sessionId,
      trigger: 'resume',
      operationId: identity.operationId,
      runRef: identity.runRef,
    });
    if (!entry) return;
    const floor = entry.owner.event_floor ?? 0;
    const [marker] = await tx.execute<{ id: number }>(sql`
      SELECT id FROM job_events j WHERE id = ${identity.markerId} AND id > ${floor}
        AND business_table = 'ingestion_agent_run' AND business_id = ${sessionId}
        AND event_type = 'agent.run_segment' AND (payload->>'segment')::int = ${segment}
        AND payload->>'outcome' IN ('running', 'failed')
        AND NOT EXISTS (SELECT 1 FROM job_events n
          WHERE n.business_table = j.business_table AND n.business_id = j.business_id
            AND n.event_type = 'agent.run_segment' AND (n.payload->>'segment')::int >= 1
            AND n.id > j.id)
    `);
    if (!marker) return;
    await writeAgentRunSegment(tx, sessionId, {
      segment,
      trigger: 'resume',
      outcome: 'failed',
    });
    await writeAgentErrorEvent(tx, sessionId, {
      kind: 'ingestion_agent.error',
      scope: 'session',
      code: 'worker_lost',
      retryable: false,
    });
    if (entry.source_document_id)
      await writeIngestionUsageReceipt(tx, {
        sourceDocumentId: entry.source_document_id,
        sessionId,
        derivationPolicy: await resolveSessionDerivationPolicy(tx, sessionId),
        engine: 'ingestion_agent',
        redactedFields: [],
        redactionAccounting: 'unavailable',
        segment,
      });
    await Ingestion.markExtractionFailed(
      tx,
      sessionId,
      'ingestion agent terminal settlement recovered; execution and cost require reconciliation',
    );
    await settleAgentRunBudget(tx, {
      sessionId,
      operationId: entry.owner.operation_id ?? undefined,
      terminal: 'failed',
      executionClosed: false,
      error: { code: 'worker_lost', reason: 'paid_attempt_outcome_unknown' },
    });
  });
}

/** Complete a run whose ledger already proves terminal — no paid call. */
async function finalizeRun(
  db: Db,
  sessionId: string,
  sourceDocumentId: string | null,
  ledger: AgentRunLedger,
  segment: number,
  trigger: 'start' | 'resume' | 'continue',
  runRef: string,
): Promise<AgentRunOutcome> {
  const counts = terminalItemCounts(ledger.items);
  const result = await db.transaction(async (tx) => {
    await requireAgentExecutionOwner(tx, sessionId, runRef);
    if (!ledger.doneEmitted) {
      await writeAgentStageEvent(tx, sessionId, {
        kind: 'ingestion_agent.stage',
        stage: 'done',
        counts: contractCounts(ledger),
      });
    }
    const completed = await Ingestion.markAgentRunCompleted(tx, {
      sessionId,
      completion: counts,
    });
    await settleAgentRunBudget(tx, {
      sessionId,
      terminal: completed.status === 'failed' ? 'failed' : 'completed',
      result: { session_status: completed.status },
    });
    await writeRunReceipt(
      tx,
      sessionId,
      sourceDocumentId,
      await resolveSessionDerivationPolicy(tx, sessionId),
      EMPTY_SINK,
      segment,
    );
    await writeAgentRunSegment(tx, sessionId, {
      segment,
      trigger,
      outcome: 'done',
    });
    return completed;
  });
  return {
    outcome: 'done',
    status: result.status,
    segment,
    terminal_items: counts.items_terminal,
    failed_items: counts.items_failed,
  };
}
