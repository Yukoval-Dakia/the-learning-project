import { and, eq } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { learning_session, source_document } from '@/db/schema';
import { resolveSessionDerivationPolicy } from '@/kernel/read-models/usage-policy';
import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/kernel/tools/allowlists';
import { type BoundRunTaskFn, makeRunTaskFn } from '@/server/ai/runner-fn';
import { piDomainMount } from '@/server/ai/tools/pi-tools';
import { Ingestion } from '@/server/session';
import {
  writeAgentErrorEvent,
  writeAgentRunSegment,
  writeAgentStageEvent,
} from '../events/agent-progress';
import { writeIngestionUsageReceipt } from '../privacy-guard';
import { readSourcePackage } from '../source-package';
import { type AgentRedactionSink, attachAgentRedactionSink } from '../tools/agent-tools';
import { listExpiredOpenAsks, readSessionAsks, resolveAskByTimeout } from './asks';
import { enqueueAgentContinuation } from './dispatch';
import { isTerminalItemStatus, readAgentRunLedger, terminalItemCounts } from './ledger';

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
//     MAX_SEGMENTS) so a premature model yield never strands the run.
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

function errorCodeForRunFailure(err: unknown): 'model_unavailable' | 'worker_lost' {
  const message = err instanceof Error ? err.message : String(err);
  return /model|provider|admission|timeout|rate|unavailable/i.test(message)
    ? 'model_unavailable'
    : 'worker_lost';
}

export async function runIngestionAgentSegment(
  db: Db,
  params: RunAgentSegmentParams,
  deps: AgentRunDeps = {},
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

  const ledger = await readAgentRunLedger(db, sessionId);
  const segment = (ledger.lastSegment?.segment ?? 0) + 1;
  if (segment > MAX_SEGMENTS) {
    const counts = terminalItemCounts(ledger.items);
    await writeAgentErrorEvent(db, sessionId, {
      kind: 'ingestion_agent.error',
      scope: 'session',
      code: 'worker_lost',
      retryable: false,
    });
    const result = await db.transaction(async (tx) =>
      Ingestion.markAgentRunCompleted(tx, {
        sessionId,
        completion: counts,
      }),
    );
    return { outcome: 'done', status: result.status, terminal_items: counts.items_terminal };
  }
  await writeAgentRunSegment(db, sessionId, {
    segment,
    trigger,
    outcome: 'running',
  });

  const derivationPolicy = await resolveSessionDerivationPolicy(db, sessionId);
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
  try {
    const result = await runTask('IngestionAgentTask', input, {
      piToolMounts: [mount],
      allowedTools: [...resolveMcpAllowedTools('ingestion')],
      budgetOverride: { maxIterations: SEGMENT_MAX_ITERATIONS, timeoutMs: SEGMENT_TIMEOUT_MS },
      providerSessionDeadlineAt: providerDeadline,
    });
    taskRunId = result.task_run_id;
  } catch (err) {
    const code = errorCodeForRunFailure(err);
    await writeAgentErrorEvent(db, sessionId, {
      kind: 'ingestion_agent.error',
      scope: 'session',
      code,
      retryable: code === 'model_unavailable',
    });
    await writeAgentRunSegment(db, sessionId, {
      segment,
      trigger,
      outcome: 'failed',
      ...(taskRunId != null ? { task_run_id: taskRunId } : {}),
    });
    const message = err instanceof Error ? err.message : String(err);
    await db
      .transaction(async (tx) => {
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

  const after = await readAgentRunLedger(db, sessionId);
  const openAskIds = after.openAsks.map((ask) => ask.ask_id);

  if (openAskIds.length > 0) {
    await writeAgentRunSegment(db, sessionId, {
      segment,
      trigger,
      outcome: 'waiting',
      open_asks: openAskIds,
      ...(taskRunId != null ? { task_run_id: taskRunId } : {}),
    });
    return { outcome: 'waiting', open_asks: openAskIds };
  }

  const counts = terminalItemCounts(after.items);
  const allTerminal =
    after.items.length > 0 && after.items.every((item) => isTerminalItemStatus(item.status));
  if (after.doneEmitted || allTerminal) {
    // Contract completeness: the done stage is emitted by the agent when it
    // finishes cleanly; when the ledger proves completion anyway (all items
    // terminal) the orchestrator emits it so the stream always ends honestly.
    if (!after.doneEmitted) {
      await writeAgentStageEvent(db, sessionId, {
        kind: 'ingestion_agent.stage',
        stage: 'done',
        counts: {
          structured: after.items.filter((item) => item.status !== 'failed').length,
          failed: counts.items_failed,
        },
      });
    }
    const result = await db.transaction(async (tx) => {
      const completed = await Ingestion.markAgentRunCompleted(tx, {
        sessionId,
        completion: counts,
      });
      if (session.source_document_id != null) {
        await writeIngestionUsageReceipt(tx, {
          sourceDocumentId: session.source_document_id,
          sessionId,
          derivationPolicy,
          engine: 'ingestion_agent',
          channels: { page_images: 'raw', extracted_text: 'redacted' },
          redactedFields: [...redactionSink.fields],
          redactionCounts: redactionSink.counts,
        });
      }
      return completed;
    });
    await writeAgentRunSegment(db, sessionId, {
      segment,
      trigger,
      outcome: 'done',
      ...(taskRunId != null ? { task_run_id: taskRunId } : {}),
    });
    return {
      outcome: 'done',
      status: result.status,
      terminal_items: counts.items_terminal,
      failed_items: counts.items_failed,
    };
  }

  // The segment ended early with no open asks and unfinished items — the model
  // yielded prematurely. Be honest about it (error event) and self-continue so
  // the run doesn't strand.
  await writeAgentErrorEvent(db, sessionId, {
    kind: 'ingestion_agent.error',
    scope: 'session',
    code: 'structure_failed',
    retryable: true,
  });
  await writeAgentRunSegment(db, sessionId, {
    segment,
    trigger,
    outcome: 'waiting',
    ...(taskRunId != null ? { task_run_id: taskRunId } : {}),
  });
  await enqueueAgentContinuation(sessionId).catch((err) =>
    console.error('[ingestion-agent] continuation enqueue failed', {
      session_id: sessionId,
      error: err,
    }),
  );
  return { outcome: 'continue', segment };
}

// ---------- segment input ----------

interface SegmentInputArgs {
  sessionId: string;
  documentId: string | null;
  packageSummary: { kind: string | null; page_count: number };
  derivationPolicy: string;
  ledger: Awaited<ReturnType<typeof readAgentRunLedger>>;
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
