import { type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Db, Tx } from '@/db/client';
import { learning_session } from '@/db/schema';
import { type SessionAskRow, readSessionAsks } from './asks';
import { readAgentBudget, writeAgentBudgetPath } from './budget-state';
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
// owner's paths). Snapshots are run-scoped: identity comes from
// execution_owner.run_ref + event_floor. A re-run demotes the previous checkpoint
// into prior_runs — it never erases it — and a v1 checkpoint without run identity
// can never be attributed to a live run, so it always demotes. Within the same
// run the checkpoint merges incrementally with the live window (stable event
// ids, id-keyed items/asks), so TTL-pruned rows are never deleted by a refresh.

const SESSION_TABLE = 'ingestion_session' as const;

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
    /** job_events.id at capture — stable dedup identity across the TTL boundary. */
    event_id: z.number().int().optional(),
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
    /** job_events.id at capture — stable dedup identity across the TTL boundary. */
    event_id: z.number().int().optional(),
    at: z.string(),
  })
  .strict();
export type AgentHistoryErrorT = z.infer<typeof HistoryErrorSchema>;

const PriorRunSchema = z
  .object({
    /** execution_owner.run_ref of that run; null on v1 checkpoints (unprovable). */
    run_ref: z.string().nullable(),
    /** That run's job_events floor; null on v1 checkpoints (unprovable). */
    event_floor: z.number().int().nullable(),
    captured_at: z.string(),
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
    /** Corrupt blob that demoted run itself carried — preserved verbatim across runs. */
    unparsed_previous: z.unknown().optional(),
  })
  .strict();
export type AgentHistoryPriorRunT = z.infer<typeof PriorRunSchema>;

export const AgentRunHistorySnapshot = z
  .object({
    version: z.number().int().min(1).max(2),
    captured_at: z.string(),
    /** learning_session.status at capture time. */
    session_status: z.string(),
    run_state: AgentHistoryRunState,
    execution_closed: z.boolean(),
    paid_outcome_unknown: z.boolean(),
    stage: IngestionAgentStage.nullable(),
    /** execution_owner.run_ref at capture — absent on v1 checkpoints. */
    run_ref: z.string().optional(),
    /** job_events.id floor at capture — rows below it belong to earlier runs. */
    event_floor: z.number().int().optional(),
    segments: z.array(HistorySegmentSchema),
    items: z.array(HistoryItemSchema),
    asks: z.array(HistoryAskSchema),
    errors: z.array(HistoryErrorSchema),
    errors_truncated: z.boolean(),
    /** Demoted checkpoints of earlier runs, newest first. */
    prior_runs: z.array(PriorRunSchema).optional(),
    /** A checkpoint that failed schema validation — preserved verbatim, never interpreted. */
    unparsed_previous: z.unknown().optional(),
  })
  .strict();
export type AgentRunHistorySnapshotT = z.infer<typeof AgentRunHistorySnapshot>;

// ---------- run identity & incremental merge ----------

/**
 * A snapshot belongs to the live run only when its stored identity matches the
 * current execution_owner. v1 checkpoints (no run_ref) are never attributable:
 * an identity-less row must not be guessed onto a new run.
 */
function snapshotMatchesRun(
  snapshot: AgentRunHistorySnapshotT | null,
  runRef: string | null,
  floor: number,
): snapshot is AgentRunHistorySnapshotT {
  return (
    snapshot != null &&
    snapshot.run_ref != null &&
    runRef != null &&
    snapshot.run_ref === runRef &&
    snapshot.event_floor === floor
  );
}

function segmentKey(seg: AgentHistorySegmentT): string {
  if (seg.event_id != null) return `e${seg.event_id}`;
  return `c:${seg.segment}:${seg.trigger}:${seg.outcome ?? ''}:${seg.task_run_id ?? ''}:${seg.at}`;
}

function errorKey(err: AgentHistoryErrorT): string {
  if (err.event_id != null) return `e${err.event_id}`;
  return `c:${err.scope}:${err.item_id ?? ''}:${err.code}:${err.at}`;
}

/** Append live rows absent from the durable copy; persisted rows never drop out. */
function unionByKey<T>(persisted: T[], live: T[], key: (row: T) => string): T[] {
  if (persisted.length === 0) return live;
  if (live.length === 0) return persisted;
  const seen = new Set(persisted.map(key));
  const out = [...persisted];
  for (const row of live) {
    const k = key(row);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(row);
    }
  }
  return out;
}

/** First-seen order kept; live rows overlay same-id entries field-wise. */
function mergeItems(
  persisted: AgentHistoryItemT[],
  live: AgentHistoryItemT[],
): AgentHistoryItemT[] {
  const items = new Map<string, AgentHistoryItemT>();
  for (const item of persisted) items.set(item.item_id, item);
  for (const item of live) items.set(item.item_id, { ...items.get(item.item_id), ...item });
  return [...items.values()];
}

function mergeAsks(persisted: AgentHistoryAskT[], live: AgentHistoryAskT[]): AgentHistoryAskT[] {
  const asks = new Map<string, AgentHistoryAskT>();
  for (const ask of persisted) asks.set(ask.ask_id, ask);
  for (const ask of live) asks.set(ask.ask_id, { ...asks.get(ask.ask_id), ...ask });
  return [...asks.values()];
}

function toPriorRun(snapshot: AgentRunHistorySnapshotT): AgentHistoryPriorRunT {
  return {
    run_ref: snapshot.run_ref ?? null,
    event_floor: snapshot.event_floor ?? null,
    captured_at: snapshot.captured_at,
    session_status: snapshot.session_status,
    run_state: snapshot.run_state,
    execution_closed: snapshot.execution_closed,
    paid_outcome_unknown: snapshot.paid_outcome_unknown,
    stage: snapshot.stage,
    segments: snapshot.segments,
    items: snapshot.items,
    asks: snapshot.asks,
    errors: snapshot.errors,
    errors_truncated: snapshot.errors_truncated,
    ...(snapshot.unparsed_previous !== undefined
      ? { unparsed_previous: snapshot.unparsed_previous }
      : {}),
  };
}

// ---------- raw timed reads (event floor applies to the current run) ----------

async function readAgentSegments(
  db: Db | Tx,
  sessionId: string,
  floor: number,
): Promise<AgentHistorySegmentT[]> {
  const rows = await db.execute<{
    id: number;
    payload: unknown;
    occurred_at: string | Date;
  }>(sql`
    SELECT id, payload, occurred_at
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
      event_id: row.id,
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
  const rows = await db.execute<{
    id: number;
    payload: unknown;
    occurred_at: string | Date;
  }>(sql`
    SELECT id, payload, occurred_at
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
      event_id: row.id,
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
     * Omit on post-close refreshes (ask resolution) — the previous same-run
     * checkpoint's run_state is kept so a settled run is never resurrected.
     */
    runState?: AgentHistoryRunStateT;
    /** False only on worker_lost — an unproven executor must not read as closed. */
    executionClosed?: boolean;
    paidOutcomeUnknown?: boolean;
  },
): Promise<void> {
  const { sessionId } = input;
  const budget = await readAgentBudget(tx, sessionId);
  const floor = budget?.execution_owner?.event_floor ?? 0;
  const runRef = budget?.execution_owner?.run_ref ?? null;
  const [ledger, asks, segments, errors, sessionRows] = await Promise.all([
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
  const liveItems: AgentHistoryItemT[] = ledger.items.map((item) => ({
    item_id: item.item_id,
    question_no: item.question_no,
    status: item.status,
    ...(item.reason !== undefined ? { reason: item.reason } : {}),
    ...(item.page !== undefined ? { page: item.page } : {}),
    ...(item.preview_md !== undefined ? { preview_md: item.preview_md } : {}),
    ...(item.draft_ref !== undefined ? { draft_ref: item.draft_ref } : {}),
    ...(item.question_id !== undefined ? { question_id: item.question_id } : {}),
    ...(item.status_at !== undefined ? { status_at: item.status_at } : {}),
  }));
  const liveAskRows = asks.map(toAsk);

  const rawPrior = (budget as { history?: unknown } | null)?.history;
  const parsedPrior = rawPrior == null ? null : AgentRunHistorySnapshot.safeParse(rawPrior);
  const priorSnapshot = parsedPrior?.success === true ? parsedPrior.data : null;
  const sameRun = snapshotMatchesRun(priorSnapshot, runRef, floor);

  // Same run → incremental merge (live rows join persisted rows; a row already
  // persisted is never lost when the live window prunes it). Different or
  // unattributable identity → the prior checkpoint demotes whole into
  // prior_runs; nothing from it may overlay this run's rows. No retention cap:
  // persisted history is never silently trimmed.
  const priorRuns: AgentHistoryPriorRunT[] = priorSnapshot?.prior_runs ?? [];
  if (priorSnapshot != null && !sameRun) priorRuns.unshift(toPriorRun(priorSnapshot));

  const mergedItems = sameRun ? mergeItems(priorSnapshot.items, liveItems) : liveItems;
  const mergedAsks = sameRun ? mergeAsks(priorSnapshot.asks, liveAskRows) : liveAskRows;
  const mergedSegments = sameRun
    ? unionByKey(priorSnapshot.segments, segments, segmentKey)
    : segments;
  const mergedErrors = sameRun ? unionByKey(priorSnapshot.errors, errors, errorKey) : errors;

  // A once-truncated record stays marked truncated — a later refresh must not
  // flip the flag and impersonate a complete history.
  const errorsTruncated = sameRun ? (priorSnapshot?.errors_truncated ?? false) : false;

  // Preserve the last corrupt snapshot verbatim. rawPrior wins when the current
  // blob itself failed to parse; a parseable prior may still carry an older
  // corrupt blob — it rides forward untouched. Never interpreted.
  const unparsedPrevious =
    parsedPrior == null
      ? undefined
      : parsedPrior.success !== true
        ? rawPrior
        : priorSnapshot?.unparsed_previous;

  const sessionStatus = sessionRows[0]?.status ?? 'unknown';
  // No prior checkpoint: a live session refreshing on ask-resolution is waiting;
  // a terminal one (e.g. timed-out ask on a settled session) is done.
  const fallbackRunState =
    sessionStatus === 'extracted' || sessionStatus === 'partial' || sessionStatus === 'failed'
      ? 'done'
      : 'waiting';
  const snapshot: AgentRunHistorySnapshotT = {
    version: 2,
    captured_at: new Date().toISOString(),
    session_status: sessionStatus,
    run_state: input.runState ?? (sameRun ? priorSnapshot?.run_state : null) ?? fallbackRunState,
    execution_closed:
      input.executionClosed ?? (sameRun ? priorSnapshot?.execution_closed : null) ?? true,
    paid_outcome_unknown:
      input.paidOutcomeUnknown ?? (sameRun ? priorSnapshot?.paid_outcome_unknown : null) ?? false,
    stage: ledger.stage ?? (sameRun ? (priorSnapshot?.stage ?? null) : null),
    ...(runRef != null ? { run_ref: runRef } : {}),
    event_floor: floor,
    segments: mergedSegments,
    items: mergedItems,
    asks: mergedAsks,
    errors: mergedErrors,
    errors_truncated: errorsTruncated,
    ...(priorRuns.length > 0 ? { prior_runs: priorRuns } : {}),
    ...(unparsedPrevious !== undefined ? { unparsed_previous: unparsedPrevious } : {}),
  };
  await writeAgentBudgetPath(tx, sessionId, ['history'], snapshot);
}

// ---------- merged read ----------

export interface AgentRunHistory {
  /** A durable snapshot exists for the CURRENT run (identity-verified). */
  snapshot: boolean;
  /** Any current-run event rows are still within the job_events window. */
  live_events: boolean;
  /** Snapshot row was present but failed to parse — treated as absent evidence. */
  corrupt_snapshot: boolean;
  /** execution_owner.run_ref of the current run; null when no owner exists. */
  run_ref: string | null;
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
  /** Sticky: the current run's durable record was ever truncated — never resets. */
  errors_truncated: boolean;
  /** Earlier runs' demoted checkpoints, newest first — never overlaid by live rows. */
  prior_runs: AgentHistoryPriorRunT[];
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
 * Merged agent-run history for the CURRENT run: live job_events rows win where
 * they exist, the identity-matched snapshot supplies whatever the 30-day window
 * no longer has. A snapshot whose run_ref/event_floor does not match the live
 * execution_owner is not overlaid — it reports under prior_runs instead (a v1
 * checkpoint without identity can never match and always demotes). When neither
 * source exists the returned slices are empty and the evidence flags say so —
 * callers must render that as unknown, never reconstruct.
 *
 * All reads run inside one REPEATABLE READ / READ ONLY transaction: owner,
 * snapshot, ledger, asks, segments and errors see a single consistent snapshot
 * — a concurrent agent operation cannot swap the floor/owner between the
 * separate SELECTs and splice a new run's live rows onto the old snapshot.
 * Takes `Db` only: a caller's own transaction cannot re-establish isolation.
 */
export async function readAgentRunHistory(db: Db, sessionId: string): Promise<AgentRunHistory> {
  return db.transaction(async (tx) => readAgentRunHistoryInTx(tx, sessionId), {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
}

async function readAgentRunHistoryInTx(tx: Tx, sessionId: string): Promise<AgentRunHistory> {
  const budget = await readAgentBudget(tx, sessionId);
  const floor = budget?.execution_owner?.event_floor ?? 0;
  const runRef = budget?.execution_owner?.run_ref ?? null;
  const [ledger, liveAsks, liveSegments, liveErrors] = await Promise.all([
    readAgentRunLedger(tx, sessionId),
    readSessionAsks(tx, sessionId, floor),
    readAgentSegments(tx, sessionId, floor),
    readAgentErrors(tx, sessionId, floor),
  ]);

  const rawSnapshot = (budget as { history?: unknown } | null)?.history;
  const parsedSnapshot =
    rawSnapshot == null ? null : AgentRunHistorySnapshot.safeParse(rawSnapshot);
  const snapshot = parsedSnapshot?.success === true ? parsedSnapshot.data : null;
  const corruptSnapshot = rawSnapshot != null && parsedSnapshot?.success !== true;
  const sameRun = snapshotMatchesRun(snapshot, runRef, floor);
  const current = sameRun ? snapshot : null;

  // Earlier runs: a non-matching checkpoint demotes ahead of its own prior list;
  // a matching one keeps the list it already carries.
  const priorRuns: AgentHistoryPriorRunT[] = snapshot?.prior_runs ?? [];
  if (snapshot != null && !sameRun) priorRuns.unshift(toPriorRun(snapshot));

  const live_events =
    ledger.items.length > 0 ||
    ledger.lastSegment != null ||
    ledger.stage != null ||
    liveAsks.length > 0 ||
    liveSegments.length > 0 ||
    liveErrors.length > 0;

  // Items: snapshot order first (first-seen), live rows overlay by item_id.
  const items = mergeItems(
    current?.items ?? [],
    ledger.items.map((item) => ({
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
  );

  // Asks: live overlay wins because resolutions can postdate the last snapshot.
  const asks = mergeAsks(current?.asks ?? [], liveAsks.map(toAsk));

  // Segments/errors: union by stable event identity — live rows absent from the
  // durable copy append; rows the live window already pruned persist.
  const segments = unionByKey(current?.segments ?? [], liveSegments, segmentKey);
  const errors = unionByKey(current?.errors ?? [], liveErrors, errorKey);

  // run_state: the snapshot's checkpoint is written in the same tx as each
  // segment close, so only a fresh 'running' marker can postdate it. Pre-snapshot
  // runs (this feature's rollout boundary) derive from the last live marker.
  let runState = current?.run_state ?? null;
  const lastLive = liveSegments.at(-1);
  if (lastLive?.outcome === 'running') runState = 'in_progress';
  else if (lastLive?.outcome === 'waiting' && runState !== 'lost') runState = 'waiting';
  else if (runState == null && lastLive?.outcome === 'early_exit') runState = 'in_progress';
  else if (runState == null && (lastLive?.outcome === 'done' || lastLive?.outcome === 'failed')) {
    runState = lastLive.outcome;
  }

  const firstSegment = segments.find((seg) => seg.segment >= 1);
  return {
    snapshot: current != null,
    live_events,
    corrupt_snapshot: corruptSnapshot,
    run_ref: runRef,
    run_state: runState,
    stage: ledger.stage ?? current?.stage ?? null,
    captured_at: current?.captured_at ?? null,
    started_at: firstSegment?.at ?? null,
    finished_at:
      runState != null && TERMINAL_RUN_STATES.includes(runState)
        ? (current?.captured_at ?? null)
        : null,
    execution_closed: current?.execution_closed ?? null,
    paid_outcome_unknown: current?.paid_outcome_unknown ?? false,
    segments,
    items,
    asks,
    errors,
    errors_truncated: current?.errors_truncated ?? false,
    prior_runs: priorRuns,
  };
}

/**
 * Single lane classifier for list + detail (F5). A session took the agent lane
 * when ANY of these exist: budget envelope evidence, surviving run events,
 * actor-scoped draft blocks (`draft:ingestion_agent:<id>` — the run's
 * sourceRefOf/draft_identity convention), or questions stamped with the
 * session's source_ref. Legacy sessions whose events and envelope rows are gone
 * still classify agent while their durable draft/question rows remain; their
 * original item state is then reported as unknown, never as extract.
 */
export function agentEvidenceSql(sessionRef: SQLWrapper): SQL {
  return sql`(
    COALESCE(${learning_session.agent_budget} -> 'operations', '{}'::jsonb) <> '{}'::jsonb
    OR COALESCE(${learning_session.agent_budget} -> 'grants', '{}'::jsonb) <> '{}'::jsonb
    OR COALESCE(${learning_session.agent_budget} ? 'history', false)
    OR EXISTS (
      SELECT 1 FROM job_events je
      WHERE je.business_table = ${INGESTION_AGENT_RUN_TABLE} AND je.business_id = ${sessionRef}
    )
    OR EXISTS (
      SELECT 1 FROM question_block qb
      WHERE qb.ingestion_session_id = 'draft:ingestion_agent:' || ${sessionRef}
    )
    OR EXISTS (
      SELECT 1 FROM question q
      WHERE q.source_ref = 'ingestion_agent:' || ${sessionRef}
    )
  )`;
}

/** Whether any durable evidence marks this session as having taken the agent lane. */
export async function hasAgentEvidence(db: Db | Tx, sessionId: string): Promise<boolean> {
  const rows = await db.execute<{ found: boolean }>(sql`
    SELECT ${agentEvidenceSql(learning_session.id)} AS found
    FROM learning_session
    WHERE ${learning_session.id} = ${sessionId} AND ${learning_session.type} = 'ingestion'
  `);
  return rows[0]?.found === true;
}
