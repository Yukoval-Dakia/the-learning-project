import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull, isNull, lt, lte, or } from 'drizzle-orm';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { tool_operation } from '@/db/schema';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { writeEvent } from '@/kernel/events';

export const TOOL_OPERATION_STATES = [
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'lost',
] as const;
export const MAX_TOOL_OPERATION_JSON_BYTES = 60 * 1024;
export const MAX_TOOL_OPERATION_ERROR_CODE_CHARS = 100;
export const MAX_TOOL_OPERATION_ERROR_MESSAGE_CHARS = 4_000;
export const MAX_TOOL_OPERATION_NAME_CHARS = 256;
export const DEFAULT_TOOL_OPERATION_LEASE_MS = 30_000;
export const DEFAULT_TOOL_OPERATION_HEARTBEAT_MS = 10_000;

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
  inputHash: string;
  input: ToolOperationJson;
  result: ToolOperationJson | null;
  error: ToolOperationError | null;
  sideEffectRisk: ToolOperationSideEffectRisk | null;
  cancelledBy: ToolOperationCancellationOwner | null;
  terminalToolCallLogId: string | null;
  hardDeadlineAt: Date | null;
  startedAt: Date;
  ownerHeartbeatAt: Date;
  leaseExpiresAt: Date;
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

export type ToolOperationExecutionOutcome =
  | {
      status: 'succeeded';
      result: ToolOperationJson;
      terminalToolCallLogId?: string | null;
    }
  | { status: 'failed'; error: ToolOperationError; terminalToolCallLogId?: string | null }
  | { status: 'cancelled'; error: ToolOperationError; terminalToolCallLogId?: string | null }
  | {
      status: 'lost';
      error: ToolOperationError;
      terminalToolCallLogId?: string | null;
    };

export interface ToolOperationHandle {
  id: string;
  wait(options: { timeoutMs: number }): Promise<ToolOperationRecord>;
  cancel(options: { requestedBy: ToolOperationCancellationOwner }): Promise<ToolOperationRecord>;
}

export interface ToolOperations {
  start(
    input: StartToolOperationInput,
    execute: (context: ToolOperationExecutionContext) => Promise<ToolOperationExecutionOutcome>,
  ): Promise<ToolOperationHandle>;
  get(id: string): Promise<ToolOperationRecord>;
  wait(id: string, options: { timeoutMs: number }): Promise<ToolOperationRecord>;
  cancel(
    id: string,
    options: { requestedBy: ToolOperationCancellationOwner },
  ): Promise<ToolOperationRecord>;
  linkTerminalToolCallLog(id: string, terminalToolCallLogId: string): Promise<ToolOperationRecord>;
  recoverLost(): Promise<ToolOperationRecord[]>;
}

export interface ToolOperationsOptions {
  processId: string;
  pollIntervalMs?: number;
  now?: () => Date;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
}

export interface ToolOperationSettlement {
  state: ToolOperationTerminalState;
  result?: ToolOperationJson | null;
  error?: ToolOperationError | null;
  sideEffectRisk?: ToolOperationSideEffectRisk | null;
  cancelledBy?: ToolOperationCancellationOwner | null;
  terminalToolCallLogId?: string | null;
}

export interface ToolOperationDeadlineTimer {
  cancel(): void;
}

function cancellationOwnerPriority(owner: ToolOperationCancellationOwner): number {
  if (owner === 'user') return 3;
  if (owner === 'model') return 2;
  return 1;
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

function isJsonValue(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, seen))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((entry) => isJsonValue(entry, seen));
  seen.delete(value);
  return valid;
}

export function validateToolOperationJson(
  value: ToolOperationJson,
  maxBytes = MAX_TOOL_OPERATION_JSON_BYTES,
  label = 'JSON',
): void {
  if (!isJsonValue(value, new WeakSet())) {
    throw new Error(`${label} must contain only finite JSON values`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > maxBytes) throw new Error(`${label} exceeds ${maxBytes} UTF-8 bytes`);
}

function truncateWithMarker(value: string, maxChars: number): string {
  const marker = '…[truncated]';
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - marker.length)}${marker}`;
}

export function summarizeToolOperationError(error: ToolOperationError): ToolOperationError {
  return {
    code: truncateWithMarker(
      error.code || 'invalid_error_code',
      MAX_TOOL_OPERATION_ERROR_CODE_CHARS,
    ),
    message: truncateWithMarker(
      error.message || 'Executor supplied an empty error summary',
      MAX_TOOL_OPERATION_ERROR_MESSAGE_CHARS,
    ),
  };
}

function validateBoundedName(value: string | null | undefined, label: string): void {
  if (value === null || value === undefined) return;
  if (value.length === 0 || value.length > MAX_TOOL_OPERATION_NAME_CHARS) {
    throw new Error(`${label} must be 1..${MAX_TOOL_OPERATION_NAME_CHARS} characters`);
  }
}

export function toolOperationDeadlineSettlement(
  effect: ToolOperationEffect,
): ToolOperationSettlement {
  const error = {
    code: 'hard_deadline_exceeded',
    message: 'Tool operation exceeded its hard deadline',
  };
  return effect === 'read'
    ? { state: 'failed', error, sideEffectRisk: null }
    : { state: 'lost', error, sideEffectRisk: 'possible' };
}

export function scheduleToolOperationHardDeadline(options: {
  effect: ToolOperationEffect;
  deadlineAt: Date;
  now: () => Date;
  onExpire: (settlement: ToolOperationSettlement) => void;
}): ToolOperationDeadlineTimer {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (): void => {
    const remainingMs = Math.max(0, options.deadlineAt.getTime() - options.now().getTime());
    timer = setTimeout(
      () => {
        if (!active) return;
        if (options.now().getTime() < options.deadlineAt.getTime()) {
          arm();
          return;
        }
        active = false;
        options.onExpire(toolOperationDeadlineSettlement(options.effect));
      },
      Math.min(remainingMs, 2_147_483_647),
    );
    timer.unref?.();
  };
  arm();
  return {
    cancel() {
      if (!active) return;
      active = false;
      if (timer) clearTimeout(timer);
    },
  };
}

type DbLike = Db | Tx;
type ToolOperationRow = typeof tool_operation.$inferSelect;

const globalForToolOperations = globalThis as typeof globalThis & {
  __loomToolOperationProcessId?: string;
};

export function getToolOperationProcessId(): string {
  globalForToolOperations.__loomToolOperationProcessId ??= `toolops_${process.pid}_${randomUUID()}`;
  return globalForToolOperations.__loomToolOperationProcessId;
}

function mapRow(row: ToolOperationRow): ToolOperationRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskRunId: row.task_run_id,
    toolName: row.tool_name,
    effect: row.effect as ToolOperationEffect,
    status: row.status as ToolOperationState,
    processId: row.process_id,
    inputHash: row.input_hash,
    input: row.input_json,
    result: row.result_json,
    error: row.error_json,
    sideEffectRisk: row.side_effect_risk as ToolOperationSideEffectRisk | null,
    cancelledBy: row.cancelled_by as ToolOperationCancellationOwner | null,
    terminalToolCallLogId: row.terminal_tool_call_log_id,
    hardDeadlineAt: row.hard_deadline_at,
    startedAt: row.started_at,
    ownerHeartbeatAt: row.owner_heartbeat_at,
    leaseExpiresAt: row.lease_expires_at,
    settledAt: row.settled_at,
    updatedAt: row.updated_at,
  };
}

function normalizeThrownError(error: unknown): ToolOperationError {
  return summarizeToolOperationError({
    code: 'execution_failed',
    message: error instanceof Error ? error.message : String(error),
  });
}

function settlementOutcome(state: ToolOperationTerminalState): 'success' | 'failure' {
  return state === 'succeeded' ? 'success' : 'failure';
}

function settlementPayload(record: ToolOperationRecord): Record<string, unknown> {
  const payload: Record<string, unknown> = { state: record.status };
  if (record.sideEffectRisk) payload.side_effect_risk = record.sideEffectRisk;
  if (record.error) payload.error = record.error;
  if (record.terminalToolCallLogId)
    payload.terminal_tool_call_log_id = record.terminalToolCallLogId;
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
    payload: { tool_name: record.toolName, effect: record.effect, process_id: record.processId },
    task_run_id: record.taskRunId,
    ingest_at: new Date(),
  });
}

async function settleOperation(
  db: Db,
  id: string,
  settlement: ToolOperationSettlement,
  now: () => Date,
): Promise<ToolOperationRecord> {
  return db.transaction(async (tx) => {
    const [currentRow] = await tx
      .select()
      .from(tool_operation)
      .where(eq(tool_operation.id, id))
      .limit(1)
      .for('update');
    if (!currentRow) throw new Error(`tool operation ${id} not found`);
    const current = mapRow(currentRow);
    const settledAt = now();
    const effectiveSettlement =
      current.hardDeadlineAt && settledAt.getTime() >= current.hardDeadlineAt.getTime()
        ? toolOperationDeadlineSettlement(current.effect)
        : settlement;
    transitionToolOperation(current.status, effectiveSettlement.state);
    const [updated] = await tx
      .update(tool_operation)
      .set({
        status: effectiveSettlement.state,
        result_json: effectiveSettlement.result ?? null,
        error_json: effectiveSettlement.error
          ? summarizeToolOperationError(effectiveSettlement.error)
          : null,
        side_effect_risk: effectiveSettlement.sideEffectRisk ?? null,
        cancelled_by: effectiveSettlement.cancelledBy ?? null,
        terminal_tool_call_log_id: effectiveSettlement.terminalToolCallLogId ?? null,
        settled_at: settledAt,
        updated_at: settledAt,
      })
      .where(and(eq(tool_operation.id, id), eq(tool_operation.status, 'running')))
      .returning();
    if (!updated) {
      const latest = await getOperation(tx, id);
      throw new InvalidToolOperationTransitionError(latest.status, effectiveSettlement.state);
    }
    const record = mapRow(updated);
    await writeSettledEvent(tx, record);
    return record;
  });
}

function settlementFromOutcome(
  outcome: ToolOperationExecutionOutcome,
  effect: ToolOperationEffect,
  cancelledBy: ToolOperationCancellationOwner | undefined,
): ToolOperationSettlement {
  try {
    validateBoundedName(outcome.terminalToolCallLogId, 'terminalToolCallLogId');
  } catch (error) {
    return {
      state: outcome.status === 'lost' ? 'lost' : 'failed',
      error: {
        code: 'executor_outcome_invalid',
        message: error instanceof Error ? error.message : String(error),
      },
      sideEffectRisk: outcome.status === 'lost' ? (effect === 'read' ? 'none' : 'possible') : null,
    };
  }
  if (outcome.status === 'succeeded') {
    try {
      validateToolOperationJson(outcome.result, undefined, 'result');
      return {
        state: 'succeeded',
        result: outcome.result,
        terminalToolCallLogId: outcome.terminalToolCallLogId,
      };
    } catch (error) {
      return {
        state: 'failed',
        error: {
          code:
            error instanceof Error && error.message.includes('exceeds')
              ? 'result_too_large'
              : 'result_contract_invalid',
          message: error instanceof Error ? error.message : String(error),
        },
        terminalToolCallLogId: outcome.terminalToolCallLogId,
      };
    }
  }
  if (outcome.status === 'lost') {
    return {
      state: 'lost',
      error: outcome.error,
      sideEffectRisk: effect === 'read' ? 'none' : 'possible',
      terminalToolCallLogId: outcome.terminalToolCallLogId,
    };
  }
  return {
    state: outcome.status,
    error: outcome.error,
    cancelledBy: outcome.status === 'cancelled' ? (cancelledBy ?? 'system') : null,
    terminalToolCallLogId: outcome.terminalToolCallLogId,
  };
}

export function createToolOperations(db: Db, options: ToolOperationsOptions): ToolOperations {
  const now = options.now ?? (() => new Date());
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_TOOL_OPERATION_LEASE_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_TOOL_OPERATION_HEARTBEAT_MS;
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error('leaseDurationMs must be a positive integer');
  }
  if (
    !Number.isInteger(heartbeatIntervalMs) ||
    heartbeatIntervalMs <= 0 ||
    heartbeatIntervalMs >= leaseDurationMs
  ) {
    throw new Error('heartbeatIntervalMs must be positive and shorter than leaseDurationMs');
  }
  if (options.processId.length === 0 || options.processId.length > MAX_TOOL_OPERATION_NAME_CHARS) {
    throw new Error(`processId must be 1..${MAX_TOOL_OPERATION_NAME_CHARS} characters`);
  }

  const controllers = new Map<string, AbortController>();
  const cancellationOwners = new Map<string, ToolOperationCancellationOwner>();
  const localSettlements = new Map<string, Promise<void>>();
  const localSettlementResolvers = new Map<string, () => void>();
  const deadlineTimers = new Map<string, ToolOperationDeadlineTimer>();
  const activeIds = new Set<string>();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const clearHeartbeatIfIdle = (): void => {
    if (activeIds.size > 0 || heartbeatTimer === null) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  const heartbeat = async (): Promise<void> => {
    if (activeIds.size === 0) {
      clearHeartbeatIfIdle();
      return;
    }
    const heartbeatAt = now();
    const rows = await db
      .update(tool_operation)
      .set({
        owner_heartbeat_at: heartbeatAt,
        lease_expires_at: new Date(heartbeatAt.getTime() + leaseDurationMs),
        updated_at: heartbeatAt,
      })
      .where(
        and(
          eq(tool_operation.status, 'running'),
          eq(tool_operation.process_id, options.processId),
          inArray(tool_operation.id, [...activeIds]),
        ),
      )
      .returning({ id: tool_operation.id });
    const liveIds = new Set(rows.map((row) => row.id));
    for (const id of activeIds) {
      if (!liveIds.has(id)) activeIds.delete(id);
    }
    clearHeartbeatIfIdle();
  };

  const ensureHeartbeat = (): void => {
    if (heartbeatTimer !== null || activeIds.size === 0) return;
    heartbeatTimer = setInterval(() => {
      void heartbeat().catch(() => undefined);
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  };

  const clearLocalState = (id: string): void => {
    deadlineTimers.get(id)?.cancel();
    deadlineTimers.delete(id);
    controllers.delete(id);
    cancellationOwners.delete(id);
    activeIds.delete(id);
    localSettlementResolvers.get(id)?.();
    localSettlementResolvers.delete(id);
    localSettlements.delete(id);
    clearHeartbeatIfIdle();
  };

  const settleFromExecution = async (
    id: string,
    settlement: ToolOperationSettlement,
  ): Promise<void> => {
    try {
      await settleOperation(db, id, settlement, now);
    } catch (error) {
      if (!(error instanceof InvalidToolOperationTransitionError)) throw error;
    } finally {
      clearLocalState(id);
    }
  };

  const scheduleDeadline = (
    id: string,
    effect: ToolOperationEffect,
    deadlineAt: Date | null | undefined,
    controller: AbortController,
  ): void => {
    if (!deadlineAt) return;
    const timer = scheduleToolOperationHardDeadline({
      effect,
      deadlineAt,
      now,
      onExpire(settlement) {
        controller.abort(new Error('Tool operation hard deadline exceeded'));
        void settleFromExecution(id, settlement).catch(() => undefined);
      },
    });
    deadlineTimers.set(id, timer);
  };

  const api: ToolOperations = {
    async start(input, execute) {
      if (input.toolName.length === 0 || input.toolName.length > MAX_TOOL_OPERATION_NAME_CHARS) {
        throw new Error(`toolName must be 1..${MAX_TOOL_OPERATION_NAME_CHARS} characters`);
      }
      validateToolOperationJson(input.input, undefined, 'input');
      const id = input.id ?? `toolop_${newId()}`;
      validateBoundedName(id, 'operation id');
      validateBoundedName(input.sessionId, 'sessionId');
      validateBoundedName(input.taskRunId, 'taskRunId');
      if (input.hardDeadlineAt && !Number.isFinite(input.hardDeadlineAt.getTime())) {
        throw new Error('hardDeadlineAt must be a valid Date');
      }
      const startedAt = now();
      const controller = new AbortController();
      await db.insert(tool_operation).values({
        id,
        session_id: input.sessionId ?? null,
        task_run_id: input.taskRunId ?? null,
        tool_name: input.toolName,
        effect: input.effect,
        status: 'running',
        process_id: options.processId,
        input_hash: sha256CanonicalJson(input.input),
        input_json: input.input,
        hard_deadline_at: input.hardDeadlineAt ?? null,
        started_at: startedAt,
        owner_heartbeat_at: startedAt,
        lease_expires_at: new Date(startedAt.getTime() + leaseDurationMs),
        updated_at: startedAt,
      });
      controllers.set(id, controller);
      activeIds.add(id);
      const localSettlement = new Promise<void>((resolve) => {
        localSettlementResolvers.set(id, resolve);
      });
      localSettlements.set(id, localSettlement);
      ensureHeartbeat();
      scheduleDeadline(id, input.effect, input.hardDeadlineAt, controller);
      void Promise.resolve()
        .then(() => execute({ operationId: id, signal: controller.signal }))
        .then(
          (outcome) =>
            settleFromExecution(
              id,
              settlementFromOutcome(outcome, input.effect, cancellationOwners.get(id)),
            ),
          (error) => {
            return input.effect === 'read'
              ? settleFromExecution(id, { state: 'failed', error: normalizeThrownError(error) })
              : settleFromExecution(id, {
                  state: 'lost',
                  error: summarizeToolOperationError({
                    code: 'execution_ambiguous',
                    message:
                      error instanceof Error
                        ? error.message
                        : 'Remote execution ended without a confirmed outcome',
                  }),
                  sideEffectRisk: 'possible',
                });
          },
        )
        .catch(() => undefined);
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
      const currentOwner = cancellationOwners.get(id);
      if (
        currentOwner === undefined ||
        cancellationOwnerPriority(cancelOptions.requestedBy) >=
          cancellationOwnerPriority(currentOwner)
      ) {
        cancellationOwners.set(id, cancelOptions.requestedBy);
      }
      controllers.get(id)?.abort(new Error(`Cancelled by ${cancelOptions.requestedBy}`));
      return record;
    },

    async linkTerminalToolCallLog(id, terminalToolCallLogId) {
      validateBoundedName(terminalToolCallLogId, 'terminalToolCallLogId');
      const [updated] = await db
        .update(tool_operation)
        .set({ terminal_tool_call_log_id: terminalToolCallLogId, updated_at: now() })
        .where(
          and(
            eq(tool_operation.id, id),
            inArray(tool_operation.status, ['succeeded', 'failed', 'cancelled', 'lost']),
            isNull(tool_operation.terminal_tool_call_log_id),
          ),
        )
        .returning();
      if (updated) return mapRow(updated);
      const current = await getOperation(db, id);
      if (current.status === 'running') {
        throw new Error(`tool operation ${id} has not settled`);
      }
      if (current.terminalToolCallLogId !== terminalToolCallLogId) {
        throw new Error(`tool operation ${id} already links another terminal tool call log`);
      }
      return current;
    },

    async recoverLost() {
      const recoveryTime = now();
      const recovered = await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(tool_operation)
          .where(
            and(
              eq(tool_operation.status, 'running'),
              or(
                lte(tool_operation.lease_expires_at, recoveryTime),
                and(
                  isNotNull(tool_operation.hard_deadline_at),
                  lte(tool_operation.hard_deadline_at, recoveryTime),
                ),
              ),
            ),
          );
        const records: ToolOperationRecord[] = [];
        for (const row of rows) {
          const leaseExpiredFirst =
            row.lease_expires_at.getTime() <= recoveryTime.getTime() &&
            (row.hard_deadline_at === null ||
              row.lease_expires_at.getTime() < row.hard_deadline_at.getTime());
          const settlement: ToolOperationSettlement = leaseExpiredFirst
            ? {
                state: 'lost',
                error: {
                  code: 'owner_lease_expired',
                  message: 'Owning process stopped heartbeating before settlement',
                },
                sideEffectRisk: row.effect === 'read' ? 'none' : 'possible',
              }
            : toolOperationDeadlineSettlement(row.effect as ToolOperationEffect);
          const recoveryCondition = leaseExpiredFirst
            ? and(
                lte(tool_operation.lease_expires_at, recoveryTime),
                or(
                  isNull(tool_operation.hard_deadline_at),
                  lt(tool_operation.lease_expires_at, tool_operation.hard_deadline_at),
                ),
              )
            : and(
                isNotNull(tool_operation.hard_deadline_at),
                lte(tool_operation.hard_deadline_at, recoveryTime),
              );
          const [updated] = await tx
            .update(tool_operation)
            .set({
              status: settlement.state,
              result_json: settlement.result ?? null,
              error_json: settlement.error ? summarizeToolOperationError(settlement.error) : null,
              side_effect_risk: settlement.sideEffectRisk ?? null,
              cancelled_by: settlement.cancelledBy ?? null,
              terminal_tool_call_log_id: settlement.terminalToolCallLogId ?? null,
              settled_at: recoveryTime,
              updated_at: recoveryTime,
            })
            .where(
              and(
                eq(tool_operation.id, row.id),
                eq(tool_operation.status, 'running'),
                recoveryCondition,
              ),
            )
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

const processToolOperations = new WeakMap<Db, ToolOperations>();

export function getProcessToolOperations(db: Db): ToolOperations {
  const existing = processToolOperations.get(db);
  if (existing) return existing;
  const created = createToolOperations(db, { processId: getToolOperationProcessId() });
  processToolOperations.set(db, created);
  return created;
}

export async function recoverToolOperationsOnBoot(db: Db): Promise<ToolOperationRecord[]> {
  try {
    return await createToolOperations(db, {
      processId: getToolOperationProcessId(),
    }).recoverLost();
  } catch (error) {
    console.error('[tool-operations] boot recovery failed (non-fatal)', error);
    return [];
  }
}
