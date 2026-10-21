import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Db, Tx } from '@/db/client';
import { learning_session } from '@/db/schema';
import { type SessionAskRow, readSessionAsks } from './asks';
import { readAgentBudget, readAgentEventFloor, writeAgentBudgetPath } from './budget-state';
import {
  AGENT_RUN_SEGMENT,
  AgentRunSegmentPayload,
  INGESTION_AGENT_ERROR,
  INGESTION_AGENT_RUN_TABLE,
  IngestionAgentErrorCode,
  IngestionAgentErrorPayload,
  IngestionAgentItemStatus,
  IngestionAgentStage,
  type IngestionAgentStageT,
  IngestionAskAnswer,
  IngestionAskOption,
} from './contract';
import { readAgentRunLedger } from './ledger';

// Durable run-history owner. job_events carry the live timeline but are pruned at
// ~30 days; this module checkpoints the run's final facts into the session's
// `agent_budget.history` JSONB subtree (writeAgentBudgetPath preserves every other
// owner's paths). One snapshot per session — retries overwrite it, so history is
// the LATEST run; questions/draft blocks from earlier runs remain linked by
// source_ref / draft: refs and surface through the API layer's union.

const SESSION_TABLE = 'ingestion_session' as const;
const MAX_HISTORY_ERRORS = 100;

// ---------- durable snapshot shape (agent_budget.history) ----------

export const AgentHistoryRunState = z.enum(['in_progress', 'waiting', 'done', 'failed', 'lost']);
export type AgentHistoryRunStateT = z.infer<typeof AgentHistoryRunState>;

const HistoryItemSchema = z
  .object({
    item_id: z.string().min(1),
    question_no: z.string().min(1),
    status: IngestionAgentItemStatus,
    reason: z.string().optional(),
    page: z.number().int().min(1).optional(),
    preview_md: z.string().optional(),
    draft_ref: z.string().optional(),
    question_id: z.string().optional(),
    status_at: z.string().optional(),
  })
  .strict();
export type AgentHistoryItemT = z.infer<typeof HistoryItemSchema>;

const HistoryAskSchema = z
  .object({
    ask_id: z.string().min(1),
    item_id: z.string().min(1),
    question_no: z.string().min(1),
    prompt_md: z.string().min(1),
    answer_kind: z.enum(['choice', 'short']),
    options: z.array(IngestionAskOption).optional(),
    placeholder: z.string(),
    expires_at: z.string().nullable(),
    created_at: z.string(),
    resolved: z
      .object({
        answer: IngestionAskAnswer,
        via: z.enum(['answer', 'timeout']),
        at: z.string(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type AgentHistoryAskT = z.infer<typeof HistoryAskSchema>;

const HistorySegmentSchema = z
  .object({
    segment: z.number().int().min(0),
    trigger: z.enum(['start', 'resume', 'continue']),
    outcome: z
      .enum([
        'running',
        'waiting',
        'done',
        'failed',
        'early_exit',
        'resume_requested',
        'continue_requested',
      ])
      .optional(),
    task_run_id: z.string().optional(),
    at: z.string(),
  })
  .strict();
export type AgentHistorySegmentT = z.infer<typeof HistorySegmentSchema>;

const HistoryErrorSchema = z
  .object({
    scope: z.enum(['session', 'item']),
    item_id: z.string().optional(),
    code: IngestionAgentErrorCode,
    retryable: z.boolean(),
    at: z.string(),
  })
  .strict();
export type AgentHistoryErrorT = z.infer<typeof HistoryErrorSchema>;

export const AgentRunHistorySnapshot = z
  .object({
    version: z.literal(1),
    captured_at: z.string(),
    /** learning_session.status at capture time. */
    session_status: z.string(),
    run_state: AgentHistoryRunState,
    execution_closed: z.boolean(),
    paid_outcome_unknown: z.boolean(),
    stage: IngestionAgentStage.nullable(),
    segments: z.array(HistorySegmentSchema),
    items: z.array(HistoryItemSchema),
    asks: z.array(HistoryAskSchema),
    errors: z.array(HistoryErrorSchema),
    errors_truncated: z.boolean(),
  })
  .strict();
export type AgentRunHistorySnapshotT = z.infer<typeof AgentRunHistorySnapshot>;

// ---------- raw timed reads (event floor applies to the current run) ----------

async function readAgentSegments(
  db: Db | Tx,
  sessionId: string,
  floor: number,
): Promise<AgentHistorySegmentT[]> {
  const rows = await db.execute<{ payload: unknown; occurred_at: string | Date }>(sql`
    SELECT payload, occurred_at
    FROM job_events
    WHERE business_table = ${INGESTION_AGENT_RUN_TABLE}
      AND business_id = ${sessionId}
      AND event_type = ${AGENT_RUN_SEGMENT}
      AND id > ${floor}
    ORDER BY id ASC
  `);
  const out: AgentHistorySegmentT[] = [];
  for (const row of rows) {
    const parsed = AgentRunSegmentPayload.safeParse(row.payload);
    if (!parsed.success) continue;
    out.push({
      segment: parsed.data.segment,
      trigger: parsed.data.trigger,
      ...(parsed.data.outcome != null ? { outcome: parsed.data.outcome } : {}),
      ...(parsed.data.task_run_id != null ? { task_run_id: parsed.data.task_run_id } : {}),
      at: new Date(row.occurred_at).toISOString(),
    });
  }
  return out;
}

async function readAgentErrors(
  db: Db | Tx,
  sessionId: string,
  floor: number,
): Promise<AgentHistoryErrorT[]> {
  const rows = await db.execute<{ payload: unknown; occurred_at: string | Date }>(sql`
    SELECT payload, occurred_at
    FROM job_events
    WHERE business_table = ${SESSION_TABLE}
      AND business_id = ${sessionId}
      AND event_type = ${INGESTION_AGENT_ERROR}
      AND id > ${floor}
    ORDER BY id ASC
  `);
  const out: AgentHistoryErrorT[] = [];
  for (const row of rows) {
    const parsed = IngestionAgentErrorPayload.safeParse(row.payload);
    if (!parsed.success) continue;
    out.push({
      scope: parsed.data.scope,
      ...(parsed.data.item_id != null ? { item_id: parsed.data.item_id } : {}),
      code: parsed.data.code,
      retryable: parsed.data.retryable,
      at: new Date(row.occurred_at).toISOString(),
    });
  }
  return out;
}

// ---------- snapshot write ----------

/**
 * Checkpoint the current run into `agent_budget.history`. Called inside the
 * settlement/pause transactions in run.ts — every segment close refreshes it, so
 * the durable copy tracks the last committed state. A failed call-site aborts the
 * tx it rides in; a read fault must not kill a terminal settlement, so callers
 * place it after the status writes it records.
 */
export async function persistAgentRunHistory(
  tx: Db | Tx,
  input: {
    sessionId: string;
    /**
     * Omit on post-close refreshes (ask resolution) — the previous
     * checkpoint's run_state is kept so a settled run is never resurrected.
     */
    runState?: AgentHistoryRunStateT;
    /** False only on worker_lost — an unproven executor must not read as closed. */
    executionClosed?: boolean;
    paidOutcomeUnknown?: boolean;
  },
): Promise<void> {
  const { sessionId } = input;
  const floor = await readAgentEventFloor(tx, sessionId);
  const [budget, ledger, asks, segments, errors, sessionRows] = await Promise.all([
    readAgentBudget(tx, sessionId),
    readAgentRunLedger(tx, sessionId),
    readSessionAsks(tx, sessionId, floor),
    readAgentSegments(tx, sessionId, floor),
    readAgentErrors(tx, sessionId, floor),
    tx
      .select({ status: learning_session.status })
      .from(learning_session)
      .where(sql`${learning_session.id} = ${sessionId}`)
      .limit(1),
  ]);
  const priorSnapshot =
    (budget as { history?: unknown } | null)?.history == null
      ? null
      : (AgentRunHistorySnapshot.safeParse((budget as { history?: unknown }).history).data ?? null);
  const sessionStatus = sessionRows[0]?.status ?? 'unknown';
  // No prior checkpoint: a live session refreshing on ask-resolution is waiting;
  // a terminal one (e.g. timed-out ask on a settled session) is done.
  const fallbackRunState =
    sessionStatus === 'extracted' || sessionStatus === 'partial' || sessionStatus === 'failed'
      ? 'done'
      : 'waiting';
  const snapshot: AgentRunHistorySnapshotT = {
    version: 1,
    captured_at: new Date().toISOString(),
    session_status: sessionStatus,
    run_state: input.runState ?? priorSnapshot?.run_state ?? fallbackRunState,
    execution_closed: input.executionClosed ?? priorSnapshot?.execution_closed ?? true,
    paid_outcome_unknown: input.paidOutcomeUnknown ?? priorSnapshot?.paid_outcome_unknown ?? false,
    stage: ledger.stage,
    segments,
    items: ledger.items.map((item) => ({
      item_id: item.item_id,
      question_no: item.question_no,
      status: item.status,
      ...(item.reason !== undefined ? { reason: item.reason } : {}),
      ...(item.page !== undefined ? { page: item.page } : {}),
      ...(item.preview_md !== undefined ? { preview_md: item.preview_md } : {}),
      ...(item.draft_ref !== undefined ? { draft_ref: item.draft_ref } : {}),
      ...(item.question_id !== undefined ? { question_id: item.question_id } : {}),
      ...(item.status_at !== undefined ? { status_at: item.status_at } : {}),
    })),
    asks: asks.map((ask) => ({
      ask_id: ask.ask_id,
      item_id: ask.created.item_id,
      question_no: ask.created.question_no,
      prompt_md: ask.created.prompt_md,
      answer_kind: ask.created.answer_kind,
      ...(ask.created.options != null ? { options: ask.created.options } : {}),
      placeholder: ask.created.placeholder,
      expires_at: ask.created.expires_at,
      created_at: ask.created_at,
      resolved:
        ask.resolved != null && ask.resolved_at != null
          ? { answer: ask.resolved.answer, via: ask.resolved.via, at: ask.resolved_at }
          : null,
    })),
    errors: errors.slice(-MAX_HISTORY_ERRORS),
    errors_truncated: errors.length > MAX_HISTORY_ERRORS,
  };
  await writeAgentBudgetPath(tx, sessionId, ['history'], snapshot);
}

// ---------- merged read ----------

export interface AgentRunHistory {
  /** A durable snapshot exists (post-this-change runs). */
  snapshot: boolean;
  /** Any current-run event rows are still within the job_events window. */
  live_events: boolean;
  /** Snapshot row was present but failed to parse — treated as absent evidence. */
  corrupt_snapshot: boolean;
  run_state: AgentHistoryRunStateT | null;
  stage: IngestionAgentStageT | null;
  captured_at: string | null;
  /** First numbered segment start. */
  started_at: string | null;
  /** Terminal checkpoint time; null while the run is not settled. */
  finished_at: string | null;
  execution_closed: boolean | null;
  paid_outcome_unknown: boolean;
  segments: AgentHistorySegmentT[];
  items: AgentHistoryItemT[];
  asks: AgentHistoryAskT[];
  errors: AgentHistoryErrorT[];
}

function toAsk(snap: SessionAskRow): AgentHistoryAskT {
  return {
    ask_id: snap.ask_id,
    item_id: snap.created.item_id,
    question_no: snap.created.question_no,
    prompt_md: snap.created.prompt_md,
    answer_kind: snap.created.answer_kind,
    ...(snap.created.options != null ? { options: snap.created.options } : {}),
    placeholder: snap.created.placeholder,
    expires_at: snap.created.expires_at,
    created_at: snap.created_at,
    resolved:
      snap.resolved != null && snap.resolved_at != null
        ? { answer: snap.resolved.answer, via: snap.resolved.via, at: snap.resolved_at }
        : null,
  };
}

const TERMINAL_RUN_STATES: readonly AgentHistoryRunStateT[] = ['done', 'failed', 'lost'];

/**
 * Merged agent-run history: live job_events rows win where they exist, the
 * durable snapshot supplies whatever the 30-day window no longer has. When both
 * are absent the returned slices are empty and the evidence flags say so —
 * callers must render that as unknown, never reconstruct.
 */
export async function readAgentRunHistory(
  db: Db | Tx,
  sessionId: string,
): Promise<AgentRunHistory> {
  const floor = await readAgentEventFloor(db, sessionId);
  const [budget, ledger, liveAsks, liveSegments, liveErrors] = await Promise.all([
    readAgentBudget(db, sessionId),
    readAgentRunLedger(db, sessionId),
    readSessionAsks(db, sessionId, floor),
    readAgentSegments(db, sessionId, floor),
    readAgentErrors(db, sessionId, floor),
  ]);

  const rawSnapshot = (budget as { history?: unknown } | null)?.history;
  const parsedSnapshot =
    rawSnapshot == null ? null : AgentRunHistorySnapshot.safeParse(rawSnapshot);
  const snapshot = parsedSnapshot?.success === true ? parsedSnapshot.data : null;
  const corruptSnapshot = rawSnapshot != null && parsedSnapshot?.success !== true;

  const live_events =
    ledger.items.length > 0 ||
    ledger.lastSegment != null ||
    ledger.stage != null ||
    liveAsks.length > 0 ||
    liveSegments.length > 0 ||
    liveErrors.length > 0;

  // Items: snapshot order first (first-seen), live rows overlay by item_id.
  const items = new Map<string, AgentHistoryItemT>();
  for (const item of snapshot?.items ?? []) items.set(item.item_id, item);
  for (const item of ledger.items) {
    const prev = items.get(item.item_id);
    items.set(item.item_id, {
      ...prev,
      item_id: item.item_id,
      question_no: item.question_no,
      status: item.status,
      ...(item.reason !== undefined ? { reason: item.reason } : {}),
      ...(item.page !== undefined ? { page: item.page } : {}),
      ...(item.preview_md !== undefined ? { preview_md: item.preview_md } : {}),
      ...(item.draft_ref !== undefined ? { draft_ref: item.draft_ref } : {}),
      ...(item.question_id !== undefined ? { question_id: item.question_id } : {}),
      ...(item.status_at !== undefined ? { status_at: item.status_at } : {}),
    });
  }

  // Asks: live overlay wins because resolutions can postdate the last snapshot.
  const asks = new Map<string, AgentHistoryAskT>();
  for (const ask of snapshot?.asks ?? []) asks.set(ask.ask_id, ask);
  for (const ask of liveAsks) asks.set(ask.ask_id, toAsk(ask));

  // Segments/errors: the live window is complete while present; otherwise the
  // snapshot is the only durable copy of the timeline.
  const segments = liveSegments.length > 0 ? liveSegments : (snapshot?.segments ?? []);
  const errors = liveErrors.length > 0 ? liveErrors : (snapshot?.errors ?? []);

  // run_state: the snapshot's checkpoint is written in the same tx as each
  // segment close, so only a fresh 'running' marker can postdate it. Pre-snapshot
  // runs (this feature's rollout boundary) derive from the last live marker.
  let runState = snapshot?.run_state ?? null;
  const lastLive = liveSegments.at(-1);
  if (lastLive?.outcome === 'running') runState = 'in_progress';
  else if (lastLive?.outcome === 'waiting' && runState !== 'lost') runState = 'waiting';
  else if (runState == null && lastLive?.outcome === 'early_exit') runState = 'in_progress';
  else if (runState == null && (lastLive?.outcome === 'done' || lastLive?.outcome === 'failed')) {
    runState = lastLive.outcome;
  }

  const firstSegment = segments.find((seg) => seg.segment >= 1);
  return {
    snapshot: snapshot != null,
    live_events,
    corrupt_snapshot: corruptSnapshot,
    run_state: runState,
    stage: ledger.stage ?? snapshot?.stage ?? null,
    captured_at: snapshot?.captured_at ?? null,
    started_at: firstSegment?.at ?? null,
    finished_at:
      runState != null && TERMINAL_RUN_STATES.includes(runState)
        ? (snapshot?.captured_at ?? null)
        : null,
    execution_closed: snapshot?.execution_closed ?? null,
    paid_outcome_unknown: snapshot?.paid_outcome_unknown ?? false,
    segments,
    items: [...items.values()],
    asks: [...asks.values()],
    errors,
  };
}

/** Whether any durable evidence marks this session as having taken the agent lane. */
export async function hasAgentEvidence(db: Db | Tx, sessionId: string): Promise<boolean> {
  const rows = await db.execute<{ found: boolean }>(sql`
    SELECT (
      COALESCE(agent_budget -> 'operations', '{}'::jsonb) <> '{}'::jsonb
      OR COALESCE(agent_budget -> 'grants', '{}'::jsonb) <> '{}'::jsonb
      OR COALESCE(agent_budget ? 'history', false)
      OR EXISTS (
        SELECT 1 FROM job_events je
        WHERE je.business_table = ${INGESTION_AGENT_RUN_TABLE} AND je.business_id = ${sessionId}
      )
    ) AS found
    FROM learning_session
    WHERE id = ${sessionId} AND type = 'ingestion'
  `);
  return rows[0]?.found === true;
}
