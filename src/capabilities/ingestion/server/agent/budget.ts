// LIGHT start permission and grant lifecycle. Permanent operation identity lives
// in operation-identity.ts; pending financial identities/canonical evidence in
// spend.ts. Execution terminals and financial settlement are independent.
import { and, eq, sql } from 'drizzle-orm';
import { resolveKeyDef } from '@/core/config/registry';
import { learnerLocalWeekWindowUtc } from '@/core/learner-day';
import type { Db, Tx } from '@/db/client';
import { learning_session, system_config } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import {
  retainUnprovenAgentReservations,
  writeIngestionOperationEvent,
  writeIngestionOperationTerminalOnce,
} from '../operation-store';
import {
  AGENT_BUDGET_EXCEEDED_CODE,
  AGENT_BUDGET_UNAVAILABLE_CODE,
  type AgentBudgetGrant,
  budgetUnavailable,
  findOpenGrant,
  loadAgentBudgetRows,
  parseAgentBudget,
  persistGrant,
  readAgentBudget,
} from './budget-state';
import { bindGrantedAgentExecution, closeAgentExecution } from './ownership';
import {
  hasUnresolvedAgentSpend,
  readAgentWeekSpend,
  retainHistoricalOcrLiabilities,
} from './spend';

const BUDGET_CONFIG_KEY = 'ingestion.agent_weekly_budget_usd';
const BUDGET_LOCK_KEY = 'ingestion-agent-weekly-budget';
const AGENT_JOB_NAME = 'ingestion_agent_run';
const AGENT_RUN_ID_PREFIX = 'ingestion_agent_run';
const AGENT_TOOL_RUN_ID_PREFIX = 'ingestion_agent_tool';
const LIVE_AGENT_JOB_STATES = "('created','retry','active')";
const RUN_OVER_SESSION_STATUSES = new Set([
  'extracted',
  'partial',
  'failed',
  'reviewed',
  'imported',
]);

function budgetExceeded(): never {
  throw new ApiError(AGENT_BUDGET_EXCEEDED_CODE, '这周录入助手的额度已用完，请下周再试。', 429);
}

async function readBudgetLimit(tx: Tx): Promise<{ value: number; revision: number | null }> {
  const def = resolveKeyDef(BUDGET_CONFIG_KEY);
  if (!def || def.schema == null) budgetUnavailable('budget_read_unavailable');

  const [row] = await tx
    .select({ value: system_config.value, revision: system_config.revision })
    .from(system_config)
    .where(eq(system_config.key, BUDGET_CONFIG_KEY))
    .limit(1);

  if (row) {
    const parsed = def.schema.safeParse(row.value);
    if (!parsed.success || typeof parsed.data !== 'number') {
      budgetUnavailable('budget_read_unavailable');
    }
    return { value: parsed.data as number, revision: row.revision };
  }

  // No DB row: use the registry fallback, explicit env first, then code default.
  const envRaw = def.envName != null ? process.env[def.envName] : undefined;
  if (envRaw !== undefined) {
    const envParsed = def.envParse ? def.envParse(envRaw) : envRaw;
    const validated = def.schema.safeParse(envParsed);
    if (validated.success && typeof validated.data === 'number') {
      return { value: validated.data as number, revision: null };
    }
    // An explicit but invalid env value fails closed instead of using the default.
    budgetUnavailable('budget_read_unavailable');
  }
  return { value: def.codeDefault as number, revision: null };
}

async function hasLiveAgentJob(tx: Tx, sessionId: string): Promise<boolean> {
  const rows = await tx.execute<{ live: boolean }>(sql`
    SELECT EXISTS(
      SELECT 1 FROM pgboss.job
      WHERE name = ${AGENT_JOB_NAME}
        AND data->>'sessionId' = ${sessionId}
        AND state IN ${sql.raw(LIVE_AGENT_JOB_STATES)}
    ) AS live
  `);
  return rows[0]?.live === true;
}

async function finalizeGrant(
  tx: Tx,
  sessionId: string,
  operationId: string,
  grant: AgentBudgetGrant,
  input: {
    settleReason: string;
    opTerminal?: {
      status: 'completed' | 'failed';
      error?: { code: string; message: string; status: number };
      result?: unknown;
    };
  },
): Promise<'settled' | 'awaiting_cost'> {
  const current = await readAgentBudget(tx, sessionId, true);
  grant = current?.grants[operationId] ?? grant;
  const now = new Date().toISOString();
  const executionClosed = input.settleReason === 'run_terminal';
  if (executionClosed) {
    // A real worker terminal clears its own execution placeholder in this
    // transaction, before checking remaining financial liabilities.
    grant = { ...grant, execution_closed_at: now };
    await persistGrant(tx, sessionId, operationId, grant);
    await closeAgentExecution(tx, sessionId, operationId);
  }
  const spend = await hasUnresolvedAgentSpend(tx);
  // A vanished job is not proof that a claimed executor cannot still send.
  const dispatchUnproven =
    ['queue_vanished', 'dispatch_unproven', 'session_terminal'].includes(input.settleReason) &&
    !grant.execution_closed_at;
  const unsettled = spend.unsettled || dispatchUnproven;
  const next: AgentBudgetGrant = {
    ...grant,
    state: unsettled ? 'awaiting_cost' : 'settled',
    settle_reason: input.settleReason,
    ...(executionClosed ? { execution_closed_at: now } : {}),
    ...(unsettled ? {} : { settled_at: now }),
  };
  await persistGrant(tx, sessionId, operationId, next);
  if (input.opTerminal) {
    await writeIngestionOperationTerminalOnce(tx, {
      operationId,
      eventType:
        input.opTerminal.status === 'completed' ? 'operation.completed' : 'operation.failed',
      payload:
        input.opTerminal.status === 'completed'
          ? { result: input.opTerminal.result ?? {} }
          : { error: input.opTerminal.error },
    });
  }
  return unsettled ? 'awaiting_cost' : 'settled';
}

async function authorizeGrant(
  tx: Tx,
  input: {
    sessionId: string;
    operationId: string;
  },
): Promise<void> {
  // Serialize globally before touching rows so every start decision shares one order.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${BUDGET_LOCK_KEY}))`);

  await retainUnprovenAgentReservations(tx);
  await retainHistoricalOcrLiabilities(tx, input.sessionId);
  const now = new Date();
  const rows = await loadAgentBudgetRows(tx);
  const ownRow = rows.find((row) => row.id === input.sessionId);
  const ownBudget = parseAgentBudget(ownRow?.agentBudget);
  const reservation = ownBudget?.operations?.[input.operationId];
  // Reservation is a prerequisite, never spending authority by itself.
  if (!reservation || reservation.status === 'failed' || reservation.status === 'completed') {
    budgetUnavailable('budget_read_unavailable');
  }
  if (ownBudget && Object.hasOwn(ownBudget.grants, input.operationId)) return;

  // Scan in-flight and awaiting-cost grants. An in-flight grant blocks only while
  // its session can still continue; proven-dead sessions go through cost settlement,
  // and unsettled cost keeps blocking as awaiting_cost.
  for (const row of rows) {
    const budget = row.id === input.sessionId ? ownBudget : parseAgentBudget(row.agentBudget);
    if (budget == null) {
      // Unparseable budget means in-flight work cannot be ruled out; fail closed.
      budgetUnavailable('budget_read_unavailable');
    }
    const open = findOpenGrant(budget);
    if (!open) continue;

    if (open.grant.state === 'awaiting_cost') {
      // Re-evaluate an awaiting-cost claim: unsettled still blocks; settled releases.
      const spend = await hasUnresolvedAgentSpend(tx);
      if (spend.unsettled) {
        budgetUnavailable('unsettled_cost', {
          session_id: row.id,
          open_task_runs: spend.openTaskRuns,
          open_attempts: spend.openAttempts,
        });
      }
      await finalizeGrant(tx, row.id, open.operationId, open.grant, {
        settleReason: 'cost_resolved',
      });
      continue;
    }

    if (RUN_OVER_SESSION_STATUSES.has(row.status)) {
      // The run ended without settlement (worker crash). Settle it; the operation
      // gets an explicit failure, and unsettled cost moves to awaiting_cost.
      const state = await finalizeGrant(tx, row.id, open.operationId, open.grant, {
        settleReason: 'session_terminal',
        opTerminal: {
          status: 'failed',
          error: {
            code: 'session_terminal',
            message: `ingestion session reached '${row.status}' before this operation could run`,
            status: 500,
          },
        },
      });
      if (state === 'awaiting_cost') {
        budgetUnavailable('unsettled_cost', { session_id: row.id });
      }
      continue;
    }
    if (row.status === 'queued' && !(await hasLiveAgentJob(tx, row.id))) {
      // Queued with no live pg-boss job: a vanished job is not proof nothing was
      // sent, so still go through cost settlement.
      const state = await finalizeGrant(tx, row.id, open.operationId, open.grant, {
        settleReason: 'queue_vanished',
        opTerminal: {
          status: 'failed',
          error: {
            code: 'queue_vanished',
            message: 'queued dispatch has no live job — the operation can be retried',
            status: 503,
          },
        },
      });
      if (state === 'awaiting_cost') {
        budgetUnavailable('unsettled_cost', { session_id: row.id });
      }
      continue;
    }
    // A queued session with a live job, an extracting run (including suspended on
    // an ask), or an uploaded one (unreachable: grant and transition share a tx) is
    // genuinely in flight, so reject.
    budgetUnavailable('another_ingestion_in_flight', { session_id: row.id });
  }

  // Pre-grant legacy: a queued agent-lane session with no grant is still in flight
  // when its events are visible in the 30-day window.
  const legacy = await tx.execute<{ id: string }>(sql`
    SELECT s.id FROM learning_session s
    WHERE s.type = 'ingestion' AND s.id <> ${input.sessionId}
      AND s.status IN ('queued', 'extracting')
      AND COALESCE(s.agent_budget->'grants', '{}'::jsonb) = '{}'::jsonb
      AND (
        COALESCE(s.agent_budget->'tasks', '{}'::jsonb) <> '{}'::jsonb
        OR COALESCE(s.agent_budget->'attributions', '[]'::jsonb) <> '[]'::jsonb
        OR
        EXISTS (
          SELECT 1 FROM job_events je
          WHERE je.business_table = 'ingestion_agent_run' AND je.business_id = s.id
        )
        OR EXISTS (
          SELECT 1 FROM job_events je
          WHERE je.business_table = 'ingestion_session' AND je.business_id = s.id
            AND je.event_type = 'ingestion.queued' AND je.payload->>'lane' = 'agent'
        )
      )
    LIMIT 1
  `);
  if (legacy.length > 0) {
    budgetUnavailable('another_ingestion_in_flight', { session_id: legacy[0].id });
  }

  // Global unsettled cost (orphan running or bound attempts) blocks new starts,
  // including pre-gate and crash residue.
  const unresolved = await hasUnresolvedAgentSpend(tx);
  if (unresolved.unsettled) {
    budgetUnavailable('unsettled_cost', {
      open_task_runs: unresolved.openTaskRuns,
      open_attempts: unresolved.openAttempts,
      unresolved_records: unresolved.unresolvedRecords,
      unproven_history: unresolved.unprovenHistory,
    });
  }

  // Authoritative config, read in-transaction with its revision.
  const limit = await readBudgetLimit(tx);
  if (limit.value <= 0) {
    // Explicit 0 is a kill switch: used is always >= 0, so it returns 429.
    budgetExceeded();
  }

  // Weekly spend: known USD counts; unknown/foreign currency is 503; used >= limit is 429.
  const week = learnerLocalWeekWindowUtc(now);
  const spend = await readAgentWeekSpend(tx, week.from, now);
  if (spend.unresolved) {
    budgetUnavailable('unsettled_cost', {
      unresolved_records: spend.unresolvedRecords,
    });
  }
  if (spend.usedUsd >= limit.value) {
    budgetExceeded();
  }

  // Write the grant in the same tx as the session transition and send, with the
  // durable idempotency binding: key/input digests, operation identity, and status.
  await persistGrant(tx, input.sessionId, input.operationId, {
    state: 'in_flight',
    week_start: week.from.toISOString(),
    limit_usd: limit.value,
    used_usd_at_grant: spend.usedUsd,
    config_revision: limit.revision,
    granted_at: now.toISOString(),
    key_digest: reservation.key_digest,
    input_digest: reservation.input_digest,
    op_status: 'accepted',
    op_updated_at: now.toISOString(),
  });
  await bindGrantedAgentExecution(tx, input.sessionId, input.operationId);
}

/**
 * Return expected denials instead of throwing them out of the dispatch tx:
 * historical liabilities and the original failed handle must COMMIT. The session
 * owner returns before queued/send; HTTP raises the error after that commit.
 */
export async function authorizeAgentRunStart(
  tx: Tx,
  input: { sessionId: string; operationId: string },
): Promise<ApiError | undefined> {
  try {
    await authorizeGrant(tx, input);
    return undefined;
  } catch (error) {
    // SQL failures abort the transaction, so persist the failed reservation in
    // the route's separate failure transaction after rollback. No dispatch ran.
    if (!(error instanceof ApiError)) {
      budgetUnavailable('budget_read_unavailable');
    }
    if (
      !(error instanceof ApiError) ||
      ![AGENT_BUDGET_EXCEEDED_CODE, AGENT_BUDGET_UNAVAILABLE_CODE].includes(error.code)
    )
      throw error;
    await writeIngestionOperationTerminalOnce(tx, {
      operationId: input.operationId,
      eventType: 'operation.failed',
      payload: { error: { code: error.code, message: error.message, status: error.status } },
    });
    return error;
  }
}

export async function settleAgentRunBudget(
  tx: Tx,
  input: {
    sessionId: string;
    /** Frozen payload owner; legacy callers may use the persisted execution owner. */
    operationId?: string;
    terminal: 'completed' | 'failed';
    /** Only a worker's real terminal proves its executor cannot send again. */
    executionClosed?: boolean;
    /** failed 时的诚实原因；code 必填，message/status 缺省补齐。 */
    error?: { code: string; message?: string; status?: number; [k: string]: unknown };
    /** completed 时的 operation.result（投影字段）。 */
    result?: unknown;
  },
): Promise<void> {
  const budget = await readAgentBudget(tx, input.sessionId, true);
  const requestedId = input.operationId ?? budget?.execution_owner?.operation_id ?? undefined;
  const requested = requestedId ? budget?.grants[requestedId] : undefined;
  const open = requestedId
    ? requested
      ? { operationId: requestedId, grant: requested }
      : null
    : null;
  const operationId = requestedId;

  if (open && budget) {
    const { code, message, status, ...extra } = input.error ?? { code: 'run_failed' };
    const opError = {
      code,
      message: message ?? code,
      status: status ?? 500,
      ...extra,
    } as { code: string; message: string; status: number };
    await finalizeGrant(tx, input.sessionId, open.operationId, open.grant, {
      settleReason: input.executionClosed === false ? 'dispatch_unproven' : 'run_terminal',
      opTerminal: {
        status: input.terminal,
        ...(input.terminal === 'completed' ? { result: input.result ?? {} } : { error: opError }),
      },
    });
  } else if (operationId) {
    const { code, message, status, ...extra } = input.error ?? { code: 'run_failed' };
    await writeIngestionOperationTerminalOnce(tx, {
      operationId,
      eventType: input.terminal === 'completed' ? 'operation.completed' : 'operation.failed',
      payload:
        input.terminal === 'completed'
          ? { result: input.result ?? {} }
          : {
              error: {
                code,
                message: message ?? code,
                status: status ?? 500,
                ...extra,
              },
            },
    });
  }
  if (input.executionClosed !== false) await closeAgentExecution(tx, input.sessionId, operationId);
}

/** The event owner advances durable identity and stream atomically. */
export async function recordAgentOperationRunning(
  tx: Tx,
  input: { sessionId: string; operationId?: string },
): Promise<void> {
  const budget = await readAgentBudget(tx, input.sessionId, true);
  const operationId = input.operationId ?? findOpenGrant(budget)?.operationId;
  if (!operationId) return;
  await writeIngestionOperationEvent(tx, {
    operationId,
    eventType: 'operation.running',
    payload: {},
  });
}

export async function agentOpOwnsSessionRun(
  db: Db | Tx,
  sessionId: string,
  operationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ agentBudget: learning_session.agent_budget })
    .from(learning_session)
    .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')))
    .limit(1);
  const budget = parseAgentBudget(row?.agentBudget);
  if (budget && Object.hasOwn(budget.grants, operationId)) return true;
  const jobs = await db.execute<{ found: boolean }>(sql`
    SELECT EXISTS(
      SELECT 1 FROM pgboss.job
      WHERE name = ${AGENT_JOB_NAME}
        AND data->>'sessionId' = ${sessionId}
        AND data->>'operationId' = ${operationId}
    ) AS found
  `);
  return jobs[0]?.found === true;
}

/** 主 run 的确定性 ai_task_runs.id（cost_ledger.task_run_id 同源）。 */
export function agentRunTaskRunId(runRef: string, segment: number): string {
  return `${AGENT_RUN_ID_PREFIX}:${runRef}:seg:${segment}`;
}

/** 直接付费工具的确定性 task run id（toolCtx.taskRunId）。 */
export function agentToolRunId(runRef: string, segment: number): string {
  return `${AGENT_TOOL_RUN_ID_PREFIX}:${runRef}:seg:${segment}`;
}
