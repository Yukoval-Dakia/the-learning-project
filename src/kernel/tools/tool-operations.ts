import { and, eq, ne } from 'drizzle-orm';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { tool_operation } from '@/db/schema';
import { writeEvent } from '@/kernel/events';

export const TOOL_OPERATION_STATES = [
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'lost',
] as const;

export type ToolOperationState = (typeof TOOL_OPERATION_STATES)[number];
export type ToolOperationTerminalState = Exclude<ToolOperationState, 'running'>;
export type ToolOperationEffect = 'read' | 'propose' | 'write';
export type ToolOperationCancellationOwner = 'model' | 'system' | 'user';
export type ToolOperationSideEffectRisk = 'none' | 'possible';
export type ToolOperationJson = Record<string, unknown>;

export interface ToolOperationError {
  code: string;
  message: string;
}

export interface ToolOperationRecord {
  id: string;
  sessionId: string | null;
  taskRunId: string | null;
  toolName: string;
  effect: ToolOperationEffect;
  status: ToolOperationState;
  processId: string;
  input: ToolOperationJson;
  result: ToolOperationJson | null;
  error: ToolOperationError | null;
  sideEffectRisk: ToolOperationSideEffectRisk | null;
  cancelledBy: ToolOperationCancellationOwner | null;
  terminalToolCallLogId: string | null;
  hardDeadlineAt: Date | null;
  startedAt: Date;
  settledAt: Date | null;
  updatedAt: Date;
}

export interface StartToolOperationInput {
  id?: string;
  sessionId?: string | null;
  taskRunId?: string | null;
  toolName: string;
  effect: ToolOperationEffect;
  input: ToolOperationJson;
  hardDeadlineAt?: Date | null;
}

export interface ToolOperationExecutionContext {
  operationId: string;
  signal: AbortSignal;
}

export interface ToolOperationExecutionResult {
  result: ToolOperationJson;
  terminalToolCallLogId?: string | null;
}

export interface ToolOperationHandle {
  id: string;
  wait(options: { timeoutMs: number }): Promise<ToolOperationRecord>;
  cancel(options: { requestedBy: ToolOperationCancellationOwner }): Promise<ToolOperationRecord>;
}

export interface ToolOperations {
  start(
    input: StartToolOperationInput,
    execute: (context: ToolOperationExecutionContext) => Promise<ToolOperationExecutionResult>,
  ): Promise<ToolOperationHandle>;
  get(id: string): Promise<ToolOperationRecord>;
  wait(id: string, options: { timeoutMs: number }): Promise<ToolOperationRecord>;
  cancel(
    id: string,
    options: { requestedBy: ToolOperationCancellationOwner },
  ): Promise<ToolOperationRecord>;
  recoverLost(): Promise<ToolOperationRecord[]>;
}

export class InvalidToolOperationTransitionError extends Error {
  constructor(from: ToolOperationState, to: ToolOperationState) {
    super(`cannot transition from ${from} to ${to}`);
    this.name = 'InvalidToolOperationTransitionError';
  }
}

export function transitionToolOperation(
  from: ToolOperationState,
  to: ToolOperationState,
): ToolOperationState {
  if (from !== 'running' || to === 'running') {
    throw new InvalidToolOperationTransitionError(from, to);
  }
  return to;
}

type DbLike = Db | Tx;
type ToolOperationRow = typeof tool_operation.$inferSelect;

function mapRow(row: ToolOperationRow): ToolOperationRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskRunId: row.task_run_id,
    toolName: row.tool_name,
    effect: row.effect as ToolOperationEffect,
    status: row.status as ToolOperationState,
    processId: row.process_id,
    input: row.input_json,
    result: row.result_json,
    error: row.error_json,
    sideEffectRisk: row.side_effect_risk as ToolOperationSideEffectRisk | null,
    cancelledBy: row.cancelled_by as ToolOperationCancellationOwner | null,
    terminalToolCallLogId: row.terminal_tool_call_log_id,
    hardDeadlineAt: row.hard_deadline_at,
    startedAt: row.started_at,
    settledAt: row.settled_at,
    updatedAt: row.updated_at,
  };
}

function normalizeError(error: unknown): ToolOperationError {
  if (error instanceof Error) {
    return { code: 'execution_failed', message: error.message };
  }
  return { code: 'execution_failed', message: String(error) };
}

function settlementOutcome(state: ToolOperationTerminalState): 'success' | 'failure' {
  return state === 'succeeded' ? 'success' : 'failure';
}

function settlementPayload(record: ToolOperationRecord): Record<string, unknown> {
  const payload: Record<string, unknown> = { state: record.status };
  if (record.sideEffectRisk) payload.side_effect_risk = record.sideEffectRisk;
  if (record.error) payload.error = record.error;
  if (record.terminalToolCallLogId) {
    payload.terminal_tool_call_log_id = record.terminalToolCallLogId;
  }
  return payload;
}

async function getOperation(db: DbLike, id: string): Promise<ToolOperationRecord> {
  const [row] = await db.select().from(tool_operation).where(eq(tool_operation.id, id)).limit(1);
  if (!row) throw new Error(`tool operation ${id} not found`);
  return mapRow(row);
}

async function writeSettledEvent(db: DbLike, record: ToolOperationRecord): Promise<void> {
  await writeEvent(db, {
    id: `evt_tool_operation_settled_${newId()}`,
    session_id: record.sessionId,
    actor_kind: 'system',
    actor_ref: 'tool_operations',
    action: 'tool_operation_settled',
    subject_kind: 'tool_operation',
    subject_id: record.id,
    outcome: settlementOutcome(record.status as ToolOperationTerminalState),
    payload: settlementPayload(record),
    task_run_id: record.taskRunId,
    ingest_at: new Date(),
  });
}

async function writeYieldedEvent(db: DbLike, record: ToolOperationRecord): Promise<void> {
  await writeEvent(db, {
    id: `evt_tool_operation_yielded_${record.id}`,
    session_id: record.sessionId,
    actor_kind: 'system',
    actor_ref: 'tool_operations',
    action: 'tool_operation_yielded',
    subject_kind: 'tool_operation',
    subject_id: record.id,
    outcome: null,
    payload: {
      tool_name: record.toolName,
      effect: record.effect,
      process_id: record.processId,
    },
    task_run_id: record.taskRunId,
    ingest_at: new Date(),
  });
}

interface Settlement {
  state: ToolOperationTerminalState;
  result?: ToolOperationJson | null;
  error?: ToolOperationError | null;
  sideEffectRisk?: ToolOperationSideEffectRisk | null;
  cancelledBy?: ToolOperationCancellationOwner | null;
  terminalToolCallLogId?: string | null;
}

async function settleOperation(
  db: Db,
  id: string,
  settlement: Settlement,
  now: () => Date,
): Promise<ToolOperationRecord> {
  return db.transaction(async (tx) => {
    const current = await getOperation(tx, id);
    transitionToolOperation(current.status, settlement.state);
    const settledAt = now();
    const [updated] = await tx
      .update(tool_operation)
      .set({
        status: settlement.state,
        result_json: settlement.result ?? null,
        error_json: settlement.error ?? null,
        side_effect_risk: settlement.sideEffectRisk ?? null,
        cancelled_by: settlement.cancelledBy ?? null,
        terminal_tool_call_log_id: settlement.terminalToolCallLogId ?? null,
        settled_at: settledAt,
        updated_at: settledAt,
      })
      .where(and(eq(tool_operation.id, id), eq(tool_operation.status, 'running')))
      .returning();
    if (!updated) {
      const latest = await getOperation(tx, id);
      throw new InvalidToolOperationTransitionError(latest.status, settlement.state);
    }
    const record = mapRow(updated);
    await writeSettledEvent(tx, record);
    return record;
  });
}

export function createToolOperations(
  db: Db,
  options: { processId: string; pollIntervalMs?: number; now?: () => Date },
): ToolOperations {
  const now = options.now ?? (() => new Date());
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const controllers = new Map<string, AbortController>();
  const cancellationOwners = new Map<string, ToolOperationCancellationOwner>();
  const localSettlements = new Map<string, Promise<void>>();

  const settleFromExecution = async (id: string, settlement: Settlement): Promise<void> => {
    try {
      await settleOperation(db, id, settlement, now);
    } catch (error) {
      if (!(error instanceof InvalidToolOperationTransitionError)) throw error;
    } finally {
      controllers.delete(id);
      cancellationOwners.delete(id);
    }
  };

  const api: ToolOperations = {
    async start(input, execute) {
      const id = input.id ?? `toolop_${newId()}`;
      const startedAt = now();
      const controller = new AbortController();
      await db.transaction(async (tx) => {
        await tx.insert(tool_operation).values({
          id,
          session_id: input.sessionId ?? null,
          task_run_id: input.taskRunId ?? null,
          tool_name: input.toolName,
          effect: input.effect,
          status: 'running',
          process_id: options.processId,
          input_json: input.input,
          hard_deadline_at: input.hardDeadlineAt ?? null,
          started_at: startedAt,
          updated_at: startedAt,
        });
      });
      controllers.set(id, controller);
      const settlement = Promise.resolve()
        .then(() => execute({ operationId: id, signal: controller.signal }))
        .then(
          (executionResult) =>
            settleFromExecution(id, {
              state: 'succeeded',
              result: executionResult.result,
              terminalToolCallLogId: executionResult.terminalToolCallLogId,
            }),
          (error) => {
            const cancelledBy = cancellationOwners.get(id);
            return cancelledBy
              ? settleFromExecution(id, {
                  state: 'cancelled',
                  error: {
                    code: 'operation_cancelled',
                    message: `Cancelled by ${cancelledBy}`,
                  },
                  cancelledBy,
                })
              : settleFromExecution(id, { state: 'failed', error: normalizeError(error) });
          },
        );
      localSettlements.set(id, settlement);
      settlement.finally(() => localSettlements.delete(id)).catch(() => undefined);
      return {
        id,
        wait: (waitOptions) => api.wait(id, waitOptions),
        cancel: (cancelOptions) => api.cancel(id, cancelOptions),
      };
    },

    get: (id) => getOperation(db, id),

    async wait(id, waitOptions) {
      if (!Number.isInteger(waitOptions.timeoutMs) || waitOptions.timeoutMs < 0) {
        throw new Error('timeoutMs must be a non-negative integer');
      }
      const current = await getOperation(db, id);
      if (current.status !== 'running') return current;
      if (waitOptions.timeoutMs === 0) {
        await writeYieldedEvent(db, current);
        return current;
      }

      const localSettlement = localSettlements.get(id);
      if (localSettlement) {
        await Promise.race([
          localSettlement,
          new Promise<void>((resolve) => setTimeout(resolve, waitOptions.timeoutMs)),
        ]);
        const observed = await getOperation(db, id);
        if (observed.status === 'running') await writeYieldedEvent(db, observed);
        return observed;
      }

      const deadline = Date.now() + waitOptions.timeoutMs;
      let observed = current;
      while (observed.status === 'running' && Date.now() < deadline) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(pollIntervalMs, deadline - Date.now())),
        );
        observed = await getOperation(db, id);
      }
      if (observed.status === 'running') await writeYieldedEvent(db, observed);
      return observed;
    },

    async cancel(id, cancelOptions) {
      const record = await getOperation(db, id);
      transitionToolOperation(record.status, 'cancelled');
      cancellationOwners.set(id, cancelOptions.requestedBy);
      controllers.get(id)?.abort(new Error(`Cancelled by ${cancelOptions.requestedBy}`));
      return record;
    },

    async recoverLost() {
      const recovered = await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(tool_operation)
          .where(
            and(
              eq(tool_operation.status, 'running'),
              ne(tool_operation.process_id, options.processId),
            ),
          );
        const records: ToolOperationRecord[] = [];
        for (const row of rows) {
          const settledAt = now();
          const sideEffectRisk: ToolOperationSideEffectRisk =
            row.effect === 'read' ? 'none' : 'possible';
          const [updated] = await tx
            .update(tool_operation)
            .set({
              status: 'lost',
              error_json: {
                code: 'process_restarted',
                message: 'Owning process exited before settlement',
              },
              side_effect_risk: sideEffectRisk,
              settled_at: settledAt,
              updated_at: settledAt,
            })
            .where(and(eq(tool_operation.id, row.id), eq(tool_operation.status, 'running')))
            .returning();
          if (!updated) continue;
          const record = mapRow(updated);
          await writeSettledEvent(tx, record);
          records.push(record);
        }
        return records;
      });
      return recovered.sort((left, right) => left.id.localeCompare(right.id));
    },
  };

  return api;
}
