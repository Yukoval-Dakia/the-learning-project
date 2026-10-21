// Copilot turn reader (replay-last-N).
//
// A "turn" is one row: a user ask or chip trigger → 'user'; an agent reply → 'ai'.
// One newest-first scan of at most `limit * 2` rows across asks, chip triggers and
// replies; interleave by (created_at, id), then keep the last `limit` so ask+reply
// pairs stay adjacent.
//
// Replay is scoped to the CURRENT reusable Copilot session, resolved with the same
// predicate find-or-create uses, and filtered on events.session_id (the event's
// conversation session; payload.session_id is a portable copy).

import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { type DerivationPolicyT, readDerivationPolicy } from '@/core/schema/derivation-policy';
import type { Db, Tx } from '@/db/client';
import { event, tool_operation } from '@/db/schema';
import { getCorrectionStatuses } from '@/kernel/events';
import { eventAllowsDerivationSql } from '@/kernel/events/derivation-policy';
import {
  findReusableCopilotConversation,
  getCopilotConversation,
} from '@/server/session/conversation';
import { type CopilotPrimaryView, parseCopilotPrimaryView } from '../primary-view-contract';
import { type CopilotSkillTurn, readCopilotSkillTurn as replySkillTurn } from './chat-contracts';
import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
  type CopilotRunStatus,
  deriveCopilotRunStatus,
} from './copilot-run-status';
import { copilotRunTerminalSql } from './copilot-run-terminal-sql';
import { selectAsksWithMaterializingToolCall } from './materializing-tools';

export type CopilotTurnRole = 'user' | 'ai' | 'tombstone';

// Persisted in the copilot_reply payload so replay restores skill state without
// re-running the LLM. The canonical type lives in chat-contracts.
export type CopilotTurnSkillTurn = CopilotSkillTurn;

export interface CopilotTurnSkillContext {
  skill: string;
  ref: { kind: string; id: string };
}

export { type CopilotPrimaryView, EPHEMERAL_HTML_REF_MAX_CHARS } from '../primary-view-contract';

export interface CopilotTurn {
  role: CopilotTurnRole;
  derivation_policy?: DerivationPolicyT;
  text: string;
  at: string; // ISO timestamp
  event_id: string;
  /** Accepted ask/chip owner of an AI reply; independent of revert eligibility. */
  run_id?: string;
  // session_id + reply_event_id let the Dock anchor a corrective chip after a
  // refresh; both are present only on AI turns.
  session_id?: string;
  reply_event_id?: string;
  /** Typed user_ask root that owns this reversible turn. */
  checkpoint_event_id?: string;
  /** Present for AI turns that carried a teaching turn or completed quiz end. */
  skill_turn?: CopilotTurnSkillTurn;
  /** Originating skill selector; paired with skill_turn for deterministic replay state. */
  skill_context?: CopilotTurnSkillContext;
  /** Present for AI turns whose reply nominated a hero deliverable. */
  primary_view?: CopilotPrimaryView;
  /** Per-call tool-use mirrors chained to this turn's ask/chip parent. */
  tool_calls?: CopilotTurnToolCall[];
  tool_operations?: CopilotTurnToolOperation[];
  subagent_runs?: CopilotTurnSubagentRun[];
}

/** Replay projection of a persisted tool_use mirror event. */
export interface CopilotTurnToolCall {
  toolName: string;
  input: Record<string, unknown>;
  summary?: string;
  errorReason?: string;
  status: 'done' | 'failed';
}

export interface CopilotTurnToolOperation {
  id: string;
  tool_name: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'lost';
}

export interface CopilotTurnSubagentRun {
  id: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'lost';
}

// The ONLY revert root the endpoint accepts. A copilot_chip_trigger is a user-role
// turn but NOT a revert root, so its reply must not surface a checkpoint_event_id
// (that would render a revert button that 404s).
const USER_ASK_ACTION = 'experimental:copilot_user_ask';
const USER_ACTIONS = [USER_ASK_ACTION, 'experimental:copilot_chip_trigger'] as const;
const REPLY_ACTION = 'experimental:copilot_reply';

const DEFAULT_TURN_LIMIT = 20;
const MAX_TURN_LIMIT = 100;

// Native SDK Task spawns never mirror through the bridge, but a corrupt or foreign
// row must not surface subagent prompts at the replay seam either (mirrors the SSE
// filter in api/tool-use-sse.ts). Must stay aligned with SPAWN_TOOL_NAME.
const NATIVE_SPAWN_TOOL_NAME = 'Task';

type DbLike = Db | Tx;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return DEFAULT_TURN_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_TURN_LIMIT);
}

function userText(payload: Record<string, unknown>): string | null {
  const v = payload.user_message;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function replyText(payload: Record<string, unknown>): string | null {
  const v = payload.reply_md;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function replyPrimaryView(payload: Record<string, unknown>): CopilotPrimaryView | undefined {
  return parseCopilotPrimaryView(payload.primary_view);
}

function replySkillContext(payload: Record<string, unknown>): CopilotTurnSkillContext | undefined {
  const sc = payload.skill_context;
  if (!sc || typeof sc !== 'object') return undefined;
  const s = sc as Record<string, unknown>;
  if (typeof s.skill !== 'string') return undefined;
  const ref = s.ref;
  if (!ref || typeof ref !== 'object') return undefined;
  const r = ref as Record<string, unknown>;
  if (typeof r.kind !== 'string' || typeof r.id !== 'string') return undefined;
  return { skill: s.skill, ref: { kind: r.kind, id: r.id } };
}

function parseToolUseMirror(
  payload: Record<string, unknown>,
  outcome: string | null,
): CopilotTurnToolCall | null {
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : null;
  if (!toolName) return null;
  if (toolName === NATIVE_SPAWN_TOOL_NAME) return null;
  const rawArgs = payload.args;
  const input =
    rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
  const summary =
    typeof payload.result_summary === 'string' && payload.result_summary.length > 0
      ? payload.result_summary
      : undefined;
  const errorReason =
    typeof payload.error_reason === 'string' && payload.error_reason.length > 0
      ? payload.error_reason
      : undefined;
  const failed = outcome === 'failure' || errorReason !== undefined;
  return {
    toolName,
    input,
    ...(summary ? { summary } : {}),
    ...(errorReason ? { errorReason } : {}),
    status: failed ? 'failed' : 'done',
  };
}

async function selectToolCallsForReplay(
  dbArg: DbLike,
  parentEventIds: readonly string[],
): Promise<Map<string, CopilotTurnToolCall[]>> {
  if (parentEventIds.length === 0) return new Map();
  const rows = await dbArg
    .select({
      caused_by: event.caused_by_event_id,
      payload: event.payload,
      outcome: event.outcome,
      created_at: event.created_at,
      id: event.id,
    })
    .from(event)
    .where(
      and(eq(event.action, 'tool_use'), inArray(event.caused_by_event_id, [...parentEventIds])),
    )
    .orderBy(asc(event.created_at), asc(event.id));

  const byParent = new Map<string, CopilotTurnToolCall[]>();
  for (const row of rows) {
    if (!row.caused_by) continue;
    const parsed = parseToolUseMirror((row.payload ?? {}) as Record<string, unknown>, row.outcome);
    if (!parsed) continue;
    const list = byParent.get(row.caused_by) ?? [];
    list.push(parsed);
    byParent.set(row.caused_by, list);
  }
  return byParent;
}

function operationStatus(
  payload: Record<string, unknown>,
): CopilotTurnToolOperation['status'] | null {
  const status = payload.state;
  return status === 'succeeded' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'lost'
    ? status
    : null;
}

function subagentRunStatus(
  payload: Record<string, unknown>,
): CopilotTurnSubagentRun['status'] | null {
  const status = payload.status;
  return status === 'succeeded' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'lost'
    ? status
    : null;
}

async function selectToolOperationsForReplay(
  dbArg: DbLike,
  sessionId: string,
  taskRunIds: readonly string[],
): Promise<Map<string, CopilotTurnToolOperation[]>> {
  if (taskRunIds.length === 0) return new Map();
  const [rows, operationRows] = await Promise.all([
    dbArg
      .select({
        action: event.action,
        subject_id: event.subject_id,
        payload: event.payload,
        task_run_id: event.task_run_id,
        created_at: event.created_at,
        id: event.id,
      })
      .from(event)
      .where(
        and(
          eq(event.session_id, sessionId),
          inArray(event.task_run_id, [...taskRunIds]),
          inArray(event.action, ['tool_operation_yielded', 'tool_operation_settled']),
        ),
      )
      .orderBy(asc(event.created_at), asc(event.id)),
    dbArg
      .select({ id: tool_operation.id, tool_name: tool_operation.tool_name })
      .from(tool_operation)
      .where(
        and(
          eq(tool_operation.session_id, sessionId),
          inArray(tool_operation.task_run_id, [...taskRunIds]),
        ),
      ),
  ]);

  const byTaskRun = new Map<string, Map<string, CopilotTurnToolOperation>>();
  const toolNameByOperationId = new Map(operationRows.map((row) => [row.id, row.tool_name]));
  for (const row of rows) {
    if (!row.task_run_id) continue;
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const current = byTaskRun.get(row.task_run_id) ?? new Map<string, CopilotTurnToolOperation>();
    if (row.action === 'tool_operation_yielded') {
      const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : null;
      if (toolName)
        current.set(row.subject_id, { id: row.subject_id, tool_name: toolName, status: 'running' });
    } else {
      const status = operationStatus(payload);
      const prior = current.get(row.subject_id);
      const toolName = prior?.tool_name ?? toolNameByOperationId.get(row.subject_id);
      if (status && toolName) {
        current.set(row.subject_id, { id: row.subject_id, tool_name: toolName, status });
      }
    }
    byTaskRun.set(row.task_run_id, current);
  }

  return new Map(
    [...byTaskRun.entries()].map(([taskRunId, operations]) => [
      taskRunId,
      [...operations.values()],
    ]),
  );
}

async function selectSubagentRunsForReplay(
  dbArg: DbLike,
  sessionId: string,
  parentEventIds: readonly string[],
): Promise<Map<string, CopilotTurnSubagentRun[]>> {
  if (parentEventIds.length === 0) return new Map();
  const starts = await dbArg
    .select({ id: event.id, subject_id: event.subject_id, caused_by: event.caused_by_event_id })
    .from(event)
    .where(
      and(
        eq(event.session_id, sessionId),
        eq(event.action, 'experimental:subagent_run_started'),
        inArray(event.caused_by_event_id, [...parentEventIds]),
      ),
    );
  if (starts.length === 0) return new Map();

  const runsByParent = new Map<string, Map<string, CopilotTurnSubagentRun>>();
  const startedParent = new Map<string, string>();
  for (const start of starts) {
    if (!start.caused_by) continue;
    startedParent.set(start.id, start.caused_by);
    const runs = runsByParent.get(start.caused_by) ?? new Map<string, CopilotTurnSubagentRun>();
    runs.set(start.subject_id, { id: start.subject_id, status: 'running' });
    runsByParent.set(start.caused_by, runs);
  }
  if (startedParent.size === 0) return new Map();

  const settled = await dbArg
    .select({
      subject_id: event.subject_id,
      caused_by: event.caused_by_event_id,
      payload: event.payload,
    })
    .from(event)
    .where(
      and(
        eq(event.session_id, sessionId),
        eq(event.action, 'experimental:subagent_run_settled'),
        inArray(event.caused_by_event_id, [...startedParent.keys()]),
      ),
    );
  for (const row of settled) {
    if (!row.caused_by) continue;
    const parentId = startedParent.get(row.caused_by);
    const runs = parentId ? runsByParent.get(parentId) : undefined;
    const status = subagentRunStatus((row.payload ?? {}) as Record<string, unknown>);
    const prior = runs?.get(row.subject_id);
    if (runs && prior && status) runs.set(row.subject_id, { ...prior, status });
  }

  return new Map(
    [...runsByParent.entries()].map(([parentId, runs]) => [parentId, [...runs.values()]]),
  );
}

type CopilotTurnRow = Pick<
  typeof event.$inferSelect,
  'id' | 'action' | 'payload' | 'created_at' | 'caused_by_event_id' | 'task_run_id'
>;

/**
 * Project newest-first event rows into the replay surface shared by the live-session
 * and durable anchor readers, so both keep identical correction, materialization,
 * tombstone, and checkpoint rules.
 */
async function projectCopilotTurnRows(
  dbArg: DbLike,
  sessionId: string,
  rows: CopilotTurnRow[],
  limit: number,
): Promise<CopilotTurn[]> {
  // Also probe each reply's parent retraction status, even when the parent fell outside this
  // window; otherwise a reply under an out-of-window retracted parent renders stale content.
  // The parent is a user_ask OR a chip_trigger, so this set is not ask-only.
  const replyParentIds = rows
    .filter((row) => row.action === REPLY_ACTION && row.caused_by_event_id)
    .map((row) => row.caused_by_event_id as string);
  // All typed user-ask ids in the window — the only valid revert roots.
  const askIds = new Set(rows.filter((row) => row.action === USER_ASK_ACTION).map((row) => row.id));
  const toolCallParentIds = [...new Set([...askIds, ...replyParentIds])];
  const taskRunIds = [
    ...new Set(
      rows
        .filter((row) => row.action === REPLY_ACTION)
        .map((row) => row.task_run_id)
        .filter((taskRunId): taskRunId is string => taskRunId !== null),
    ),
  ];
  const [
    statuses,
    asksWithMaterializingTool,
    toolCallsByParent,
    toolOperationsByTaskRun,
    subagentRunsByParent,
    replyRoots,
  ] = await Promise.all([
    getCorrectionStatuses(dbArg, [...new Set([...rows.map((row) => row.id), ...replyParentIds])]),
    selectAsksWithMaterializingToolCall(dbArg, [...askIds]),
    selectToolCallsForReplay(dbArg, toolCallParentIds),
    selectToolOperationsForReplay(dbArg, sessionId, taskRunIds),
    selectSubagentRunsForReplay(dbArg, sessionId, toolCallParentIds),
    replyParentIds.length
      ? dbArg
          .select({ id: event.id, payload: event.payload })
          .from(event)
          .where(
            and(
              inArray(event.id, replyParentIds),
              eq(event.session_id, sessionId),
              inArray(event.action, [...USER_ACTIONS]),
            ),
          )
      : Promise.resolve([]),
  ]);
  const replyRunIds = new Set(replyRoots.map((root) => root.id));
  // 受限根策略投影到回复 turn：answer_only 根回 answer_only，crisis 根回 crisis。
  const restrictedRootPolicies = new Map(
    replyRoots
      .filter((root) => readDerivationPolicy(root.payload) !== 'allow')
      .map((root) => [root.id, readDerivationPolicy(root.payload)] as const),
  );
  // Out-of-window parents are included: a reply under one is skipped, not shown stale.
  const retractedParentIds = new Set(
    [...askIds, ...replyParentIds].filter((id) => statuses.get(id)?.state === 'retracted'),
  );
  // A teaching_check turn materializes a draft question via structured_question; key it by
  // ask id so the ask and reply rows suppress consistently.
  const structuredQuestionAskIds = new Set(
    rows
      .filter((row) => row.action === REPLY_ACTION && row.caused_by_event_id)
      .filter(
        (row) =>
          replySkillTurn((row.payload ?? {}) as Record<string, unknown>)?.structured_question,
      )
      .map((row) => row.caused_by_event_id as string),
  );
  // Ambiguous recovery or a cancellation that observed a materializing tool start
  // outranks an absent mirror: after refresh no side may resurrect an unsafe anchor.
  const checkpointUnsafeAskIds = new Set(
    rows
      .filter((row) => row.action === REPLY_ACTION && row.caused_by_event_id)
      .filter((row) => {
        const payload = (row.payload ?? {}) as Record<string, unknown>;
        const durableFailure = payload.durable_failure;
        if (
          durableFailure === null ||
          typeof durableFailure !== 'object' ||
          Array.isArray(durableFailure)
        ) {
          return false;
        }
        const failure = durableFailure as Record<string, unknown>;
        return failure.reason === 'ambiguous_execution' || failure.checkpoint_safe === false;
      })
      .map((row) => row.caused_by_event_id as string),
  );
  // Anchor ⇔ every effect is event-chain-compensable (materializing-tools.ts). Suppress for a
  // teaching_check draft or a materializing domain tool, on both the ask and reply rows.
  const anchorSuppressed = (askId: string): boolean =>
    asksWithMaterializingTool.has(askId) ||
    structuredQuestionAskIds.has(askId) ||
    checkpointUnsafeAskIds.has(askId);

  const turns: CopilotTurn[] = [];
  for (const row of rows) {
    const checkpointEventId = row.action === USER_ASK_ACTION ? row.id : row.caused_by_event_id;
    if (checkpointEventId && retractedParentIds.has(checkpointEventId)) {
      if (row.id === checkpointEventId) {
        turns.push({
          role: 'tombstone',
          text: '本轮更改已撤回',
          at: row.created_at.toISOString(),
          event_id: row.id,
          checkpoint_event_id: row.id,
        });
      }
      continue;
    }
    if (statuses.get(row.id)?.state === 'retracted') continue;
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    if (row.action === REPLY_ACTION) {
      const text = replyText(payload);
      if (text === null) continue;
      const skillTurn = replySkillTurn(payload);
      const skillContext = replySkillContext(payload);
      const primaryView = replyPrimaryView(payload);
      const turn: CopilotTurn = {
        role: 'ai',
        derivation_policy:
          row.caused_by_event_id && restrictedRootPolicies.has(row.caused_by_event_id)
            ? (restrictedRootPolicies.get(row.caused_by_event_id) as DerivationPolicyT)
            : readDerivationPolicy(payload),
        text,
        at: row.created_at.toISOString(),
        event_id: row.id,
        ...(row.caused_by_event_id && replyRunIds.has(row.caused_by_event_id)
          ? { run_id: row.caused_by_event_id }
          : {}),
        // Dock chip renderer needs the conversation and reply event ids.
        session_id: sessionId,
        reply_event_id: row.id,
        // Only a reply rooted at a typed user_ask exposes a revert affordance; suppress a
        // materializing turn's anchor so a refresh can't 409 or orphan a row.
        ...(checkpointEventId &&
        askIds.has(checkpointEventId) &&
        !anchorSuppressed(checkpointEventId)
          ? { checkpoint_event_id: checkpointEventId }
          : {}),
      };
      if (skillTurn) turn.skill_turn = skillTurn;
      if (skillContext) turn.skill_context = skillContext;
      if (primaryView) turn.primary_view = primaryView;
      const parentId = row.caused_by_event_id;
      if (parentId) {
        const toolCalls = toolCallsByParent.get(parentId);
        if (toolCalls && toolCalls.length > 0) turn.tool_calls = toolCalls;
        const subagentRuns = subagentRunsByParent.get(parentId);
        if (subagentRuns && subagentRuns.length > 0) turn.subagent_runs = subagentRuns;
      }
      const toolOperations = row.task_run_id
        ? toolOperationsByTaskRun.get(row.task_run_id)
        : undefined;
      if (toolOperations && toolOperations.length > 0) turn.tool_operations = toolOperations;
      turns.push(turn);
    } else {
      const text = userText(payload);
      if (text === null) continue;
      turns.push({
        role: 'user',
        derivation_policy: readDerivationPolicy(payload),
        text,
        at: row.created_at.toISOString(),
        event_id: row.id,
        // The ask row anchors the same checkpoint and must honour the same suppression.
        ...(row.action === USER_ASK_ACTION && !anchorSuppressed(row.id)
          ? { checkpoint_event_id: row.id }
          : {}),
      });
    }
  }

  // rows are newest-first; keep the newest `limit`, then reverse to chronological.
  return turns.slice(0, limit).reverse();
}

/**
 * Returns the most recent turns oldest→newest, capped at `limit` (default 20, max 100).
 * Rows without usable text are dropped: replay is best-effort prefill, never the
 * source of truth.
 */
export async function getRecentCopilotTurns(
  dbArg: DbLike,
  opts: { limit?: number; now?: Date; sessionId?: string; forModel?: boolean } = {},
): Promise<CopilotTurn[]> {
  const limit = clampLimit(opts.limit);

  // Scope replay to the CURRENT reusable session, resolved with the same predicate
  // find-or-create uses, so a stale conversation is never replayed into a fresh one.
  const session = opts.sessionId
    ? await getCopilotConversation(dbArg, opts.sessionId)
    : await findReusableCopilotConversation(dbArg, { now: opts.now });
  if (session === null) return [];

  // Bounded by limit*2: one user + one reply row per turn. Filter on events.session_id
  // (the conversation session, shared with teaching; payload.session_id is the copy).
  const rows = await dbArg
    .select({
      id: event.id,
      action: event.action,
      payload: event.payload,
      created_at: event.created_at,
      caused_by_event_id: event.caused_by_event_id,
      task_run_id: event.task_run_id,
    })
    .from(event)
    .where(
      and(
        eq(event.session_id, session.id),
        ...(opts.forModel ? [eventAllowsDerivationSql()] : []),
        or(inArray(event.action, [...USER_ACTIONS]), eq(event.action, REPLY_ACTION)),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(limit * 2);

  return projectCopilotTurnRows(dbArg, session.id, rows, limit);
}

export interface CopilotActiveRun {
  run_id: string;
  session_id: string;
  status: CopilotRunStatus;
  events_url: string;
  derivation_policy?: DerivationPolicyT;
}

/** One database snapshot; a new browser needs no local cache to discover accepted work. */
export async function getCopilotConversationSnapshot(
  dbArg: Db,
  opts: { limit?: number; now?: Date; sessionId?: string; forModel?: boolean } = {},
): Promise<{ session_id: string | null; turns: CopilotTurn[]; active_runs: CopilotActiveRun[] }> {
  return dbArg.transaction(
    async (tx) => {
      const session = opts.sessionId
        ? await getCopilotConversation(tx, opts.sessionId)
        : await findReusableCopilotConversation(tx, { now: opts.now });
      if (!session) return { session_id: null, turns: [], active_runs: [] };
      const turns = await getRecentCopilotTurns(tx, { ...opts, sessionId: session.id });
      const terminal = copilotRunTerminalSql(
        sql.raw('terminal.event_type'),
        sql.raw('terminal.payload'),
      );
      const runs = (await tx.execute(sql`
      SELECT queued.business_id AS run_id, ask.payload AS ask_payload,
        ARRAY(SELECT DISTINCT progress.event_type FROM job_events progress
          WHERE progress.business_table = queued.business_table AND progress.business_id = queued.business_id
            AND progress.event_type IN (${COPILOT_RUN_EVENTS.STARTED}, ${COPILOT_RUN_EVENTS.EXECUTION_STARTED}, ${COPILOT_RUN_EVENTS.STEP}, ${COPILOT_RUN_EVENTS.CANCEL_REQUESTED})) AS event_types
      FROM job_events queued
      JOIN event ask ON ask.id = queued.business_id
      WHERE queued.business_table = ${COPILOT_RUN_TABLE}
        AND queued.event_type = ${COPILOT_RUN_EVENTS.QUEUED}
        AND ask.session_id = ${session.id}
        AND queued.payload->>'session_id' = ${session.id}
        AND queued.id = (SELECT min(first_queued.id) FROM job_events first_queued
          WHERE first_queued.business_table = queued.business_table AND first_queued.business_id = queued.business_id AND first_queued.event_type = ${COPILOT_RUN_EVENTS.QUEUED})
        AND NOT EXISTS (SELECT 1 FROM job_events terminal
          WHERE terminal.business_table = queued.business_table AND terminal.business_id = queued.business_id AND ${terminal})
      ORDER BY ask.dispatch_seq ASC, ask.id ASC
    `)) as Array<{ run_id: string; event_types: string[]; ask_payload: unknown }>;
      return {
        session_id: session.id,
        turns,
        active_runs: runs.map((run) => ({
          run_id: run.run_id,
          derivation_policy: readDerivationPolicy(run.ask_payload),
          session_id: session.id,
          status: deriveCopilotRunStatus(run.event_types.map((event_type) => ({ event_type }))),
          events_url: `/api/jobs/copilot_run/${encodeURIComponent(run.run_id)}/events`,
        })),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

export type CopilotHistoryAnchorErrorReason =
  | 'missing_anchor'
  | 'invalid_anchor_action'
  | 'session_mismatch';

/**
 * A durable run must never silently switch to whatever conversation is reusable when
 * the worker picks it up. Wrong action/session fails closed; `missing_anchor` stays
 * distinguishable so the assembler can apply its explicit legacy fallback.
 */
export class CopilotHistoryAnchorError extends Error {
  constructor(
    readonly reason: CopilotHistoryAnchorErrorReason,
    readonly anchorEventId: string,
  ) {
    super(`Copilot history anchor integrity failure: ${reason}`);
    this.name = 'CopilotHistoryAnchorError';
  }
}

/**
 * Read the causal conversation history for one durable Copilot run.
 *
 * Roots are eligible only before the anchor coordinate. A reply follows its causal
 * root, so a late reply to an earlier root is kept while replies to the anchor or
 * later roots are excluded; parentless legacy replies use their own coordinate.
 * Eligibility applies before the LIMIT so future traffic cannot evict real history.
 */
export async function getCopilotTurnsBeforeAnchor(
  dbArg: DbLike,
  opts: { sessionId: string; anchorEventId: string; limit?: number; forModel?: boolean },
): Promise<CopilotTurn[]> {
  const limit = clampLimit(opts.limit);
  const [anchor] = await dbArg
    .select({
      action: event.action,
      session_id: event.session_id,
    })
    .from(event)
    .where(eq(event.id, opts.anchorEventId))
    .limit(1);

  if (!anchor) {
    throw new CopilotHistoryAnchorError('missing_anchor', opts.anchorEventId);
  }
  if (!USER_ACTIONS.includes(anchor.action as (typeof USER_ACTIONS)[number])) {
    throw new CopilotHistoryAnchorError('invalid_anchor_action', opts.anchorEventId);
  }
  if (anchor.session_id !== opts.sessionId) {
    throw new CopilotHistoryAnchorError('session_mismatch', opts.anchorEventId);
  }

  // Keep bigint dispatch_seq inside Postgres: reading an anchor value in JavaScript would
  // lose precision once the sequence exceeds Number.MAX_SAFE_INTEGER.
  const historyAnchor = alias(event, 'copilot_history_anchor');
  const historyParent = alias(event, 'copilot_history_parent');
  // A queued reply may be inserted after several later roots. Sort attributed replies by
  // their ROOT coordinate and place each immediately before its root in newest-first
  // order; the projector reverses this to root→reply pairs. Ordering before LIMIT
  // prevents a backlog from producing orphan replies or blocks of users then AIs.
  const causalDispatchSeq = sql<number>`case
    when ${event.action} = ${REPLY_ACTION}
      then coalesce(${historyParent.dispatch_seq}, ${event.dispatch_seq})
    else ${event.dispatch_seq}
  end`;
  const replyWithinRoot = sql<number>`case when ${event.action} = ${REPLY_ACTION} then 1 else 0 end`;
  const rows = await dbArg
    .select({
      id: event.id,
      action: event.action,
      payload: event.payload,
      created_at: event.created_at,
      caused_by_event_id: event.caused_by_event_id,
      task_run_id: event.task_run_id,
    })
    .from(event)
    .innerJoin(historyAnchor, eq(historyAnchor.id, opts.anchorEventId))
    .leftJoin(historyParent, eq(historyParent.id, event.caused_by_event_id))
    .where(
      and(
        eq(event.session_id, opts.sessionId),
        ...(opts.forModel ? [eventAllowsDerivationSql()] : []),
        or(
          // Root user turns use the anchor's stable insertion-order boundary.
          and(
            inArray(event.action, [...USER_ACTIONS]),
            lt(event.dispatch_seq, historyAnchor.dispatch_seq),
          ),
          and(
            eq(event.action, REPLY_ACTION),
            or(
              // Legacy replies may predate caused_by_event_id attribution.
              and(
                isNull(event.caused_by_event_id),
                lt(event.dispatch_seq, historyAnchor.dispatch_seq),
              ),
              // Attributed replies inherit eligibility from their root, even when the
              // reply itself was inserted after the anchor.
              and(
                eq(historyParent.session_id, opts.sessionId),
                inArray(historyParent.action, [...USER_ACTIONS]),
                lt(historyParent.dispatch_seq, historyAnchor.dispatch_seq),
              ),
            ),
          ),
        ),
      ),
    )
    .orderBy(desc(causalDispatchSeq), desc(replyWithinRoot), desc(event.dispatch_seq))
    .limit(limit * 2);

  return projectCopilotTurnRows(dbArg, opts.sessionId, rows, limit);
}

/** Positions only, never reply text. Correction references cannot hydrate a restricted turn. */
export async function getCopilotReplyPoliciesBeforeAnchor(
  db: DbLike,
  opts: { sessionId: string; anchorEventId?: string; now?: Date },
) {
  const parent = alias(event, 'correction_parent');
  const anchor = alias(event, 'correction_anchor');
  const rows = await db
    .select({
      id: event.id,
      parentId: parent.id,
      policy: sql<unknown>`case when coalesce(${event.payload}->>'derivation_policy', 'allow') <> 'allow' then ${event.payload}->>'derivation_policy' when coalesce(${parent.payload}->>'derivation_policy', 'allow') <> 'allow' then ${parent.payload}->>'derivation_policy' else 'allow' end`,
    })
    .from(event)
    .leftJoin(anchor, eq(anchor.id, opts.anchorEventId ?? ''))
    .leftJoin(parent, eq(parent.id, event.caused_by_event_id))
    .where(
      and(
        eq(event.session_id, opts.sessionId),
        eq(event.action, REPLY_ACTION),
        opts.anchorEventId
          ? lt(sql`coalesce(${parent.dispatch_seq}, ${event.dispatch_seq})`, anchor.dispatch_seq)
          : lte(event.created_at, opts.now ?? new Date()),
      ),
    )
    .orderBy(
      desc(sql`coalesce(${parent.dispatch_seq}, ${event.dispatch_seq})`),
      desc(event.dispatch_seq),
    )
    .limit(MAX_TURN_LIMIT);
  const statuses = await getCorrectionStatuses(
    db,
    rows.flatMap((row) => (row.parentId ? [row.id, row.parentId] : [row.id])),
  );
  return rows
    .filter(
      (row) =>
        statuses.get(row.id)?.state !== 'retracted' &&
        (!row.parentId || statuses.get(row.parentId)?.state !== 'retracted'),
    )
    .reverse()
    .map((row) => ({
      event_id: row.id,
      derivation_policy: readDerivationPolicy({ derivation_policy: row.policy }),
    }));
}
