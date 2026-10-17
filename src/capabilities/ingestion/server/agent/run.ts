import { and, eq } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { DerivationPolicyT } from '@/core/schema/derivation-policy';
import type { Db, Tx } from '@/db/client';
import { learning_session, source_document } from '@/db/schema';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { resolveSessionDerivationPolicy } from '@/kernel/read-models/usage-policy';
import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/kernel/tools/allowlists';
import {
  AgentRunError,
  type BoundRunTaskFn,
  ProviderAttemptLifecycleError,
  ProviderSessionAdmissionError,
  isProviderSessionWallClockBudgetError,
  isTransientAgentFailure,
  makeRunTaskFn,
} from '@/server/ai/runner-fn';
import { piDomainMount } from '@/server/ai/tools/pi-tools';
import { JOB_RETRY_LIMIT } from '@/server/boss/queue-config';
import { Ingestion } from '@/server/session';
import {
  writeAgentErrorEvent,
  writeAgentItemEvent,
  writeAgentRunSegment,
  writeAgentStageEvent,
} from '../events/agent-progress';
import { writeIngestionUsageReceipt } from '../privacy-guard';
import { readSourcePackage } from '../source-package';
import { type AgentRedactionSink, attachAgentRedactionSink } from '../tools/redaction-sink';
import { listExpiredOpenAsks, readSessionAsks, resolveAskByTimeout } from './asks';
import type { IngestionAgentErrorCodeT, IngestionAgentStageCountsT } from './contract';
import { enqueueAgentContinuation } from './dispatch';
import {
  type AgentRunLedger,
  claimRunSegment,
  isTerminalItemStatus,
  readAgentRunLedger,
  terminalItemCounts,
} from './ledger';

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
//     the segment 'running' until the stale-segment sweeper closes it and
//     resumes the run — the paid call is never re-run for a ledger fault.
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
  /** pg-boss delivery count — drives the retries-exhausted terminal write. */
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

const EMPTY_SINK: AgentRedactionSink = { fields: new Set(), counts: {} };

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

/**
 * Deterministic per-run tool-call identity (P1-5.5): a redelivery of the same
 * logical call replays the owner's idempotent write instead of duplicating it.
 * Also stamps every draft created from this surface with its provenance
 * (source.ref = 'ingestion_agent:<session>') so a page-copied key can be
 * traced back to this lane.
 */
function agentInterceptInput(sessionId: string) {
  return (tool: { name: string; effect: unknown }, args: unknown) => {
    const input = args as Record<string, unknown>;
    if (input == null) return { args };
    if (tool.name === 'submit_question' && typeof input.draft === 'object' && input.draft) {
      const draftRef = (input.draft as { draft_ref?: unknown }).draft_ref;
      return {
        args: { ...input, request_id: `r8:${sessionId}:submit:${String(draftRef)}` },
      };
    }
    if (tool.name === 'edit_question') {
      const next = { ...input };
      next.request_id = `r8:${sessionId}:edit:${sha256CanonicalJson({
        action: input.action ?? null,
        draft_ref: input.draft_ref ?? null,
        question_id: input.question_id ?? null,
        document: input.document ?? null,
        ops: input.ops ?? null,
      })}`;
      if (input.document && typeof input.document === 'object') {
        const doc = input.document as Record<string, unknown>;
        const modelSource =
          doc.source && typeof doc.source === 'object'
            ? (doc.source as { note?: unknown }).note
            : undefined;
        next.document = {
          ...doc,
          source: {
            kind: 'photo_ingest',
            ref: `ingestion_agent:${sessionId}`,
            ...(typeof modelSource === 'string' ? { note: modelSource } : {}),
          },
        };
      }
      return { args: next };
    }
    return { args };
  };
}

export async function runIngestionAgentSegment(
  db: Db,
  params: RunAgentSegmentParams,
  deps: AgentRunDeps = {},
): Promise<AgentRunOutcome> {
  try {
    return await runSegmentInner(db, params, deps);
  } catch (err) {
    // P2 — a throw can only come from pre-model plumbing (the paid call's
    // outcome is durably recorded before returning). When the queue's retries
    // are exhausted this is the last delivery: leave the session honestly
    // failed instead of 'extracting' forever.
    if ((params.retryCount ?? 0) >= JOB_RETRY_LIMIT) {
      await db
        .transaction(async (tx) => {
          await writeAgentErrorEvent(tx, params.sessionId, {
            kind: 'ingestion_agent.error',
            scope: 'session',
            code: 'worker_lost',
            retryable: false,
          });
          await Ingestion.markExtractionFailed(
            tx,
            params.sessionId,
            'ingestion agent run exhausted queue retries',
          );
        })
        .catch((secondary) =>
          console.error('[ingestion-agent] retries-exhausted terminal write failed', {
            session_id: params.sessionId,
            error: secondary,
          }),
        );
    }
    throw err;
  }
}

async function runSegmentInner(
  db: Db,
  params: RunAgentSegmentParams,
  deps: AgentRunDeps,
): Promise<AgentRunOutcome> {
  const { sessionId, trigger } = params;
  const runTask = deps.runTaskFn ?? makeRunTaskFn(db);

  const [session] = await db
    .select({
      status: learning_session.status,
      source_document_id: learning_session.source_document_id,
    })
    .from(learning_session)
    .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')))
    .limit(1);
  if (session == null) return { outcome: 'skipped', status: 'not_found' };

  if (session.status === 'queued') {
    const started = await db
      .transaction(async (tx) => {
        await Ingestion.markExtractionStarted(tx, sessionId);
        return true;
      })
      .catch(() => false);
    // A concurrent delivery already transitioned it (the pre-read was stale) —
    // this delivery is a duplicate, not an error.
    if (!started) return { outcome: 'skipped', status: 'already_started' };
  } else if (session.status !== 'extracting') {
    return { outcome: 'skipped', status: session.status };
  }

  await sweepExpiredAsksForSession(db, sessionId);

  // P1-5.1 — durable mutual exclusion: one open segment per session.
  const claim = await db.transaction(async (tx) =>
    claimRunSegment(tx, sessionId, trigger, MAX_SEGMENTS),
  );

  if (claim.kind === 'busy') {
    return { outcome: 'skipped', status: 'segment_in_flight' };
  }
  if (claim.kind === 'over_cap') {
    // MAX_SEGMENTS — mark every non-terminal item failed (worker_lost) so the
    // completion counts are honest, then complete + receipt (paid work did run).
    const ledger = claim.ledger;
    const prior = terminalItemCounts(ledger.items);
    const stranded = ledger.items.filter((item) => !isTerminalItemStatus(item.status));
    await db.transaction(async (tx) => {
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
      await writeRunReceipt(
        tx,
        sessionId,
        session.source_document_id,
        await resolveSessionDerivationPolicy(tx, sessionId),
        EMPTY_SINK,
      );
      return done;
    });
    await writeAgentErrorEvent(db, sessionId, {
      kind: 'ingestion_agent.error',
      scope: 'session',
      code: 'worker_lost',
      retryable: false,
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
    await writeAgentRunSegment(db, sessionId, {
      segment,
      trigger,
      outcome: 'waiting',
      open_asks: openAskIds,
    });
    return { outcome: 'waiting', open_asks: openAskIds, segment };
  }
  const allTerminal =
    ledger.items.length > 0 && ledger.items.every((item) => isTerminalItemStatus(item.status));
  if (ledger.doneEmitted || allTerminal) {
    return finalizeRun(db, sessionId, session.source_document_id, ledger, segment, trigger);
  }

  const derivationPolicy = await resolveSessionDerivationPolicy(db, sessionId);

  // derivation_policy: the shared tool bridge denies every needed tool under
  // 'answer_only'/'crisis' — refuse the paid run honestly at entry rather than
  // burning a doomed segment. The receipt still records the policy truth.
  if (derivationPolicy !== 'allow') {
    const sink: AgentRedactionSink = { fields: new Set(), counts: {} };
    await db.transaction(async (tx) => {
      await writeRunReceipt(tx, sessionId, session.source_document_id, derivationPolicy, sink);
      await Ingestion.markExtractionFailed(
        tx,
        sessionId,
        `usage policy '${derivationPolicy}' does not permit bank ingestion`,
      );
    });
    await writeAgentRunSegment(db, sessionId, { segment, trigger, outcome: 'failed' });
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
  const toolCtx = {
    db,
    taskRunId: `ingestion_agent_tool_${newId()}`,
    providerAttemptCaller: 'worker' as const,
    providerSessionDeadlineAt: providerDeadline,
    callerActor: { kind: 'agent' as const, ref: `ingestion_agent:${sessionId}` },
    scope: { kind: 'ingestion_session', id: sessionId },
    derivationPolicy,
  };
  const redactionSink: AgentRedactionSink = attachAgentRedactionSink(toolCtx);
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
  });

  let taskRunId: string | undefined;
  deps.throwBeforeModel?.();
  try {
    const result = await runTask('IngestionAgentTask', input, {
      piToolMounts: [mount],
      allowedTools: [...resolveMcpAllowedTools('ingestion')],
      budgetOverride: { maxIterations: SEGMENT_MAX_ITERATIONS, timeoutMs: SEGMENT_TIMEOUT_MS },
      providerSessionDeadlineAt: providerDeadline,
    });
    taskRunId = result.task_run_id;
  } catch (err) {
    const { code, retryable } = classifyRunFailure(err);
    await writeAgentErrorEvent(db, sessionId, {
      kind: 'ingestion_agent.error',
      scope: 'session',
      code,
      retryable,
    });
    await writeAgentRunSegment(db, sessionId, {
      segment,
      trigger,
      outcome: 'failed',
      ...(taskRunId != null ? { task_run_id: taskRunId } : {}),
    });
    const message = err instanceof Error ? err.message : String(err);
    // Paid work happened — the receipt is written on failure paths too.
    await db
      .transaction(async (tx) => {
        await writeRunReceipt(
          tx,
          sessionId,
          session.source_document_id,
          derivationPolicy,
          redactionSink,
          segment,
        );
        await Ingestion.markExtractionFailed(tx, sessionId, message.slice(0, 500));
      })
      .catch((secondary) =>
        console.error('[ingestion-agent] failed to mark session failed', {
          session_id: sessionId,
          error: secondary,
        }),
      );
    return { outcome: 'failed', error: message.slice(0, 500) };
  }

  // P1-5.3 — bookkeeping after the paid call is isolated: a throw here logs,
  // leaves the segment 'running' for the stale-segment sweeper to close, and
  // returns normally so pg-boss never retries the whole PAID segment.
  try {
    deps.throwBeforeBookkeeping?.();
    const after = await readAgentRunLedger(db, sessionId);
    const afterOpen = after.openAsks.map((ask) => ask.ask_id);

    if (afterOpen.length > 0) {
      // Per-segment usage receipt: the paid call + this segment's redactions
      // are usage even though the run is suspended.
      await db.transaction(async (tx) => {
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
      if (!after.doneEmitted) {
        await writeAgentStageEvent(db, sessionId, {
          kind: 'ingestion_agent.stage',
          stage: 'done',
          counts: contractCounts(after),
        });
      }
      const result = await db.transaction(async (tx) => {
        const completed = await Ingestion.markAgentRunCompleted(tx, {
          sessionId,
          completion: terminalItemCounts(after.items),
        });
        await writeRunReceipt(
          tx,
          sessionId,
          session.source_document_id,
          derivationPolicy,
          redactionSink,
          segment,
        );
        return completed;
      });
      await writeAgentRunSegment(db, sessionId, {
        segment,
        trigger,
        outcome: 'done',
        ...(taskRunId != null ? { task_run_id: taskRunId } : {}),
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
    // bookkeeping only (early_exit marker), never a session-scope error. The
    // self-continuation keeps the run from stranding.
    await writeAgentRunSegment(db, sessionId, {
      segment,
      trigger,
      outcome: 'early_exit',
      ...(taskRunId != null ? { task_run_id: taskRunId } : {}),
    });
    await enqueueAgentContinuation(sessionId).catch((err) =>
      console.error('[ingestion-agent] continuation enqueue failed', {
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
}

/** Complete a run whose ledger already proves terminal — no paid call. */
async function finalizeRun(
  db: Db,
  sessionId: string,
  sourceDocumentId: string | null,
  ledger: AgentRunLedger,
  segment: number,
  trigger: 'start' | 'resume' | 'continue',
): Promise<AgentRunOutcome> {
  if (!ledger.doneEmitted) {
    await writeAgentStageEvent(db, sessionId, {
      kind: 'ingestion_agent.stage',
      stage: 'done',
      counts: contractCounts(ledger),
    });
  }
  const counts = terminalItemCounts(ledger.items);
  const result = await db.transaction(async (tx) => {
    const completed = await Ingestion.markAgentRunCompleted(tx, {
      sessionId,
      completion: counts,
    });
    await writeRunReceipt(
      tx,
      sessionId,
      sourceDocumentId,
      await resolveSessionDerivationPolicy(tx, sessionId),
      EMPTY_SINK,
      segment,
    );
    return completed;
  });
  await writeAgentRunSegment(db, sessionId, {
    segment,
    trigger,
    outcome: 'done',
  });
  return {
    outcome: 'done',
    status: result.status,
    segment,
    terminal_items: counts.items_terminal,
    failed_items: counts.items_failed,
  };
}

// ---------- segment input ----------

interface SegmentInputArgs {
  sessionId: string;
  documentId: string | null;
  packageSummary: { kind: string | null; page_count: number };
  derivationPolicy: string;
  ledger: AgentRunLedger;
  segment: number;
  trigger: 'start' | 'resume' | 'continue';
}

function buildAgentSegmentInput(args: SegmentInputArgs): string {
  const { ledger } = args;
  const resume = args.segment > 1 || ledger.items.length > 0 || ledger.asks.length > 0;
  const items = ledger.items.map((item) => ({
    item_id: item.item_id,
    question_no: item.question_no,
    status: item.status,
    ...(item.page !== undefined ? { page: item.page } : {}),
    ...(item.draft_ref !== undefined ? { draft_ref: item.draft_ref } : {}),
    ...(item.question_id !== undefined ? { question_id: item.question_id } : {}),
  }));
  const asks = ledger.asks.map((ask) => ({
    ask_id: ask.ask_id,
    item_id: ask.created.item_id,
    question_no: ask.created.question_no,
    prompt_md: ask.created.prompt_md,
    answer_kind: ask.created.answer_kind,
    expires_at: ask.created.expires_at,
    ...(ask.created.context_md != null ? { context_md: ask.created.context_md } : {}),
    resolved: ask.resolved?.answer ?? null,
  }));
  return JSON.stringify({
    task: 'ingest_source_package',
    session_id: args.sessionId,
    document_id: args.documentId,
    package: args.packageSummary,
    derivation_policy: args.derivationPolicy,
    segment: args.segment,
    trigger: args.trigger,
    resume: resume
      ? {
          last_stage: ledger.stage,
          items,
          asks,
          note: 'Resume: items/asks above are durable truth. Continue unfinished items; resolved asks carry the learner answer; open asks are still pending — keep working on other items or end the turn again.',
        }
      : null,
  });
}
