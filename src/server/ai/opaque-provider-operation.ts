import { randomUUID } from 'node:crypto';
import { ProviderRequestIdentity } from '@/core/schema/provider-attempt';
import type { Db } from '@/db/client';
import { providerOperationIdForInvocation } from './direct-provider-attempt';
import {
  type ProviderAttemptHandle,
  type ProviderAttemptLifecycle,
  type ProviderAttemptLifecycleMode,
  createProviderAttemptLifecycle,
} from './provider-attempt-lifecycle';

export type Mem0OpaqueOperationKind =
  | 'add_inferred'
  | 'add_verbatim'
  | 'restore_verbatim'
  | 'search';

export type Mem0OpaqueLifecycleFactory = (input: {
  readonly mode: ProviderAttemptLifecycleMode;
  readonly identity: ProviderAttemptLifecycle['identity'];
  readonly deadlineAt: Date;
  readonly db?: Db;
}) => ProviderAttemptLifecycle;

export interface Mem0OpaqueOperationContext {
  readonly caller: 'api' | 'worker';
  readonly deadlineAt: Date;
  readonly operationId: string;
  readonly db?: Db;
  readonly createLifecycle?: Mem0OpaqueLifecycleFactory;
}

export interface Mem0OpaqueOperationOptions {
  readonly db?: Db;
  readonly caller: 'api' | 'worker';
  readonly deadlineAt: Date;
  readonly operationAnchor: string;
  readonly createLifecycle?: Mem0OpaqueLifecycleFactory;
}

const ENDPOINT_BY_OPERATION = {
  add_inferred: 'memory.add',
  add_verbatim: 'memory.add',
  restore_verbatim: 'memory.add',
  search: 'memory.search',
} as const satisfies Record<Mem0OpaqueOperationKind, string>;

export function createMem0OpaqueOperationContext(
  input: Mem0OpaqueOperationOptions,
): Mem0OpaqueOperationContext {
  return Object.freeze({
    db: input.db,
    caller: input.caller,
    deadlineAt: input.deadlineAt,
    operationId: providerOperationIdForInvocation(input.operationAnchor),
    createLifecycle: input.createLifecycle,
  });
}

function makeLifecycle(
  context: Mem0OpaqueOperationContext,
  operationKind: Mem0OpaqueOperationKind,
): ProviderAttemptLifecycle {
  const identity = ProviderRequestIdentity.parse({
    attemptId: randomUUID(),
    operationId: context.operationId,
    attemptKind: 'opaque_operation',
    provider: 'mem0',
    model: null,
    lane: 'mem0.event-memory',
    protocol: 'mem0-oss-sdk',
    endpointClass: ENDPOINT_BY_OPERATION[operationKind],
    caller: context.caller,
    operationKind,
  });
  if (context.createLifecycle) {
    return context.createLifecycle({
      mode: 'observe',
      identity,
      deadlineAt: context.deadlineAt,
      db: context.db,
    });
  }
  if (!context.db) throw new TypeError('Mem0 opaque operation context requires db');
  return createProviderAttemptLifecycle({
    mode: 'observe',
    identity,
    deadlineAt: context.deadlineAt,
    db: context.db,
  });
}

const UNKNOWN_USAGE = {
  basis: 'unknown',
  unit: null,
  input: null,
  output: null,
  total: null,
  source: 'mem0_sdk_usage_unavailable',
} as const;

const UNKNOWN_COST = {
  basis: 'unknown',
  amount: null,
  currency: null,
  source: 'mem0_sdk_cost_unavailable',
} as const;

type Mem0SettlementInput = {
  readonly handle: ProviderAttemptHandle;
  readonly identity: ProviderAttemptLifecycle['identity'];
  readonly operationKind: Mem0OpaqueOperationKind;
  readonly terminal: 'succeeded' | 'failed';
};

async function settleMem0OpaqueOperation(input: Mem0SettlementInput): Promise<void> {
  try {
    const settlement = await input.handle.finish({
      terminal: input.terminal,
      reason:
        input.terminal === 'succeeded' ? 'provider_response_accepted' : 'provider_attempt_failed',
      wireCount: null,
      usage: UNKNOWN_USAGE,
      cost: UNKNOWN_COST,
    });
    if (settlement === 'settled') return;
    console.error(
      '[mem0-provider-operation] terminal settlement failed; preserving provider outcome',
      {
        attemptId: input.identity.attemptId,
        operationId: input.identity.operationId,
        operationKind: input.operationKind,
        caller: input.identity.caller,
        settlementReason: 'finish_untracked',
        settlementMessage: 'terminal evidence was not durably recorded',
      },
    );
  } catch {
    console.error(
      '[mem0-provider-operation] terminal settlement failed; preserving provider outcome',
      {
        attemptId: input.identity.attemptId,
        operationId: input.identity.operationId,
        operationKind: input.operationKind,
        caller: input.identity.caller,
        settlementReason: 'finish_threw',
        settlementMessage: 'terminal evidence settlement threw',
      },
    );
  }
}

export async function executeMem0OpaqueOperation<T>(
  context: Mem0OpaqueOperationContext,
  operationKind: Mem0OpaqueOperationKind,
  execute: () => Promise<T>,
): Promise<T> {
  const lifecycle = makeLifecycle(context, operationKind);
  const handle = await lifecycle.acquire();
  await handle.reserveProviderStart();
  let outcome:
    | { readonly kind: 'success'; readonly value: T }
    | { readonly kind: 'failure'; readonly error: unknown };
  try {
    outcome = { kind: 'success', value: await execute() };
  } catch (error) {
    outcome = { kind: 'failure', error };
  }

  switch (outcome.kind) {
    case 'success':
      await settleMem0OpaqueOperation({
        handle,
        identity: lifecycle.identity,
        operationKind,
        terminal: 'succeeded',
      });
      return outcome.value;
    case 'failure':
      await settleMem0OpaqueOperation({
        handle,
        identity: lifecycle.identity,
        operationKind,
        terminal: 'failed',
      });
      throw outcome.error;
  }
}
