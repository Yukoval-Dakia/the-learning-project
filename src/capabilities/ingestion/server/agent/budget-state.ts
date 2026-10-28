import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { learning_session } from '@/db/schema';
import { ApiError } from '@/kernel/http';

// Internal persisted representation shared by the two owners: operation identity
// and spend/grants. Path writes preserve every other owner's history.
export const AGENT_BUDGET_WEEK_TZ = 'Asia/Shanghai' as const;
export const AGENT_BUDGET_LOCK_KEY = 'ingestion-agent-weekly-budget';
export const AGENT_TASK_KIND = 'IngestionAgentTask';
export const AGENT_TOOL_RUN_ID_PREFIX = 'ingestion_agent_tool';
export const AGENT_BUDGET_EXCEEDED_CODE = 'ingestion_weekly_budget_exceeded';
export const AGENT_BUDGET_UNAVAILABLE_CODE = 'ingestion_weekly_budget_unavailable';

export type AgentBudgetUnavailableReason =
  | 'another_ingestion_in_flight'
  | 'unsettled_cost'
  | 'budget_read_unavailable';

export function budgetUnavailable(
  reason: AgentBudgetUnavailableReason,
  details?: Record<string, unknown>,
): never {
  throw new ApiError(
    AGENT_BUDGET_UNAVAILABLE_CODE,
    reason === 'another_ingestion_in_flight'
      ? '另一个录入还在进行中，请等它结束后再试。'
      : '暂时无法确认录入助手的剩余额度，请稍后再试。',
    503,
    undefined,
    { reason, ...details },
  );
}

const errorSchema = z
  .object({ code: z.string(), message: z.string(), status: z.number() })
  .passthrough();
const statusSchema = z.enum(['accepted', 'running', 'completed', 'failed']);

const grantSchema = z
  .object({
    state: z.enum(['in_flight', 'awaiting_cost', 'settled']),
    week_start: z.string(),
    limit_usd: z.number(),
    used_usd_at_grant: z.number(),
    config_revision: z.number().int().nullable(),
    granted_at: z.string(),
    settled_at: z.string().optional(),
    settle_reason: z.string().optional(),
    execution_closed_at: z.string().optional(),
    key_digest: z.string().nullable().optional(),
    input_digest: z.string().optional(),
    op_status: statusSchema.optional(),
    op_error: errorSchema.optional(),
    op_result: z.unknown().optional(),
    op_updated_at: z.string().optional(),
  })
  .passthrough();
export type AgentBudgetGrant = z.infer<typeof grantSchema>;

const operationSchema = z
  .object({
    key_digest: z.string().nullable(),
    input_digest: z.string(),
    status: statusSchema,
    created_at: z.string(),
    updated_at: z.string(),
    error: errorSchema.optional(),
    result: z.unknown().optional(),
    // Missing on pre-transactional reservations: dispatch outcome is unproven.
    dispatch_state: z.enum(['not_started', 'enqueued', 'closed', 'unproven']).optional(),
  })
  .passthrough();
export type AgentOperationIdentity = z.infer<typeof operationSchema>;

const attributionSchema = z
  .object({
    operation_id: z.string(),
    task_run_id: z.string(),
    tool: z.string(),
    bound_at: z.string(),
    // Old bindings have no attempt_id. Their absence is NOT unsent evidence.
    liability_id: z.string().optional(),
    attempt_id: z.string().optional(),
  })
  .passthrough();
export type AgentBudgetAttribution = z.infer<typeof attributionSchema>;

const historySchema = z
  .object({
    operation_id: z.string(),
    ownership: z.enum(['agent', 'independent', 'unproven']),
    evidence_log_ids: z.array(z.string()),
    agent_log_ids: z.array(z.string()).optional(),
    independent_log_ids: z.array(z.string()).optional(),
    first_seen_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();
export type HistoricalOcrIdentity = z.infer<typeof historySchema>;

const executionOwnerSchema = z.object({
  operation_id: z.string().nullable(),
  run_ref: z.string(),
  protocol: z.enum(['transactional-v1', 'legacy']),
  state: z.enum(['active', 'closed']),
  event_floor: z.number().int().optional(),
  usage_epoch: z.string().optional(),
  stop_request_id: z.string().optional(),
  stop_confirmed: z.boolean().optional(),
  segment_state: z.enum(['running', 'idle']).optional(),
  segment_claim: z.string().min(1).optional(),
});
export type AgentExecutionOwner = z.infer<typeof executionOwnerSchema>;

const envelopeSchema = z
  .object({
    week_tz: z.literal(AGENT_BUDGET_WEEK_TZ),
    grants: z.record(z.string(), grantSchema),
    operations: z.record(z.string(), operationSchema).optional(),
    attributions: z.array(attributionSchema).optional(),
    tasks: z.record(z.string(), z.object({ bound_at: z.string() }).passthrough()).optional(),
    historical_ocr: z.record(z.string(), historySchema).optional(),
    execution_owner: executionOwnerSchema.optional(),
    execution_intents: z.record(z.string(), executionOwnerSchema).optional(),
    unproven_dispatches: z
      .record(z.string(), z.object({ reason: z.string(), observed_at: z.string() }))
      .optional(),
  })
  .passthrough();
export type AgentBudgetEnvelope = z.infer<typeof envelopeSchema>;

export function parseAgentBudget(raw: unknown): AgentBudgetEnvelope | null {
  if (raw == null) return null;
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) budgetUnavailable('budget_read_unavailable');
  return parsed.data;
}

export async function readAgentBudget(db: Db | Tx, sessionId: string, lock = false) {
  const rows = await db.execute<{ agent_budget: unknown }>(sql`
    SELECT agent_budget FROM learning_session
    WHERE id = ${sessionId} AND type = 'ingestion'
    ${lock ? sql`FOR UPDATE` : sql``}
  `);
  if (!rows[0]) throw new ApiError('not_found', `ingestion session ${sessionId} not found`, 404);
  return parseAgentBudget(rows[0].agent_budget);
}

/** New starts read only their own ledger; retained old runs remain readable. */
export async function readAgentEventFloor(db: Db | Tx, sessionId: string): Promise<number> {
  return (await readAgentBudget(db, sessionId))?.execution_owner?.event_floor ?? 0;
}

// Normalize only missing fields. Do not replace the envelope or strip unknown
// fields: the column also contains immutable historical grants and bindings.
export const AGENT_BUDGET_BASE_SQL = sql`
  jsonb_build_object(
    'week_tz', ${AGENT_BUDGET_WEEK_TZ}::text, 'grants', '{}'::jsonb,
    'operations', '{}'::jsonb, 'attributions', '[]'::jsonb,
    'tasks', '{}'::jsonb, 'historical_ocr', '{}'::jsonb, 'execution_intents', '{}'::jsonb, 'unproven_dispatches', '{}'::jsonb
  ) || COALESCE(agent_budget, '{}'::jsonb)
`;

export async function writeAgentBudgetPath(
  tx: Db | Tx,
  sessionId: string,
  path: string[],
  value: unknown,
): Promise<void> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE learning_session
    SET agent_budget = jsonb_set(${AGENT_BUDGET_BASE_SQL},
      ARRAY[${sql.join(
        path.map((part) => sql`${part}`),
        sql`, `,
      )}]::text[],
      ${JSON.stringify(value)}::jsonb, true)
    WHERE id = ${sessionId} AND type = 'ingestion'
    RETURNING id
  `);
  if (rows.length !== 1) budgetUnavailable('budget_read_unavailable');
}

export async function persistGrant(
  tx: Tx,
  sessionId: string,
  operationId: string,
  grant: AgentBudgetGrant,
): Promise<void> {
  await writeAgentBudgetPath(tx, sessionId, ['grants', operationId], grant);
}

export function findOpenGrant(envelope: AgentBudgetEnvelope | null) {
  for (const [operationId, grant] of Object.entries(envelope?.grants ?? {})) {
    if (grant.state !== 'settled') return { operationId, grant };
  }
  return null;
}

export async function loadAgentBudgetRows(tx: Tx) {
  return tx
    .select({
      id: learning_session.id,
      status: learning_session.status,
      agentBudget: learning_session.agent_budget,
    })
    .from(learning_session)
    .where(
      and(
        eq(learning_session.type, 'ingestion'),
        sql`${learning_session.agent_budget} IS NOT NULL`,
      ),
    );
}
