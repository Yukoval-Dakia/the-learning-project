import { createHash, randomUUID } from 'node:crypto';
import {
  CurrencyCode,
  type ProviderAttemptCostTruth,
  type ProviderAttemptTerminal,
  type ProviderAttemptUsageTruth,
  ProviderOperationId,
  ProviderRequestIdentity,
  type ProviderRequestIdentity as ProviderRequestIdentityT,
} from '@/core/schema/provider-attempt';
import type { Db } from '@/db/client';
import {
  ProviderAttemptAdmissionLaneSchema,
  type ProviderAttemptAdmissionPolicy,
  resolveProviderAttemptAdmission,
} from './provider-attempt-admission-config';
import {
  type ProviderAttemptLifecycle,
  ProviderAttemptLifecycleError,
  type ProviderAttemptLifecycleMode,
  createProviderAttemptLifecycle,
} from './provider-attempt-lifecycle';
export { glmChatCostCny } from './pricing';

export type DirectProviderLifecycleFactory = (input: {
  readonly mode: ProviderAttemptLifecycleMode;
  readonly policy?: ProviderAttemptAdmissionPolicy | null;
  readonly identity: ProviderRequestIdentityT;
  readonly deadlineAt: Date;
  readonly db?: Db;
}) => ProviderAttemptLifecycle;

export interface DirectProviderOperationContext {
  readonly caller: 'api' | 'worker';
  readonly deadlineAt: Date;
  readonly mode?: ProviderAttemptLifecycleMode;
  readonly policy?: ProviderAttemptAdmissionPolicy | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly operationId: string;
  readonly db?: Db;
  readonly createLifecycle?: DirectProviderLifecycleFactory;
}

export interface DirectProviderOperationOptions {
  readonly db?: Db;
  readonly caller: 'api' | 'worker';
  readonly deadlineAt: Date;
  readonly mode?: ProviderAttemptLifecycleMode;
  readonly policy?: ProviderAttemptAdmissionPolicy | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly operationAnchor?: string;
  readonly createLifecycle?: DirectProviderLifecycleFactory;
}

export interface DirectProviderAttemptDescriptor {
  readonly provider: string;
  readonly model: string | null;
  readonly lane: string;
  readonly protocol: string;
  readonly endpointClass: string;
  readonly operationKind: string;
  readonly unknownCostCurrency: 'CNY' | 'USD' | null;
  readonly attemptAnchor?: string;
}

export interface DirectProviderAttemptControl {
  readonly attemptId: string;
  recordExternalRequestId(id: string): Promise<void>;
  reportUsage(usage: {
    readonly input: number | null;
    readonly output: number | null;
    readonly total: number | null;
  }): void;
  estimateCost(cost: {
    readonly amount: number;
    readonly currency: 'CNY' | 'USD';
    readonly source: string;
  }): void;
  markTerminal(terminal: ProviderAttemptTerminal, reason: string): void;
}

export interface DirectProviderAttemptResult<T> {
  readonly value: T;
  readonly attemptId: string;
}

export function isDirectProviderAttemptInvariantError(
  error: unknown,
): error is ProviderAttemptLifecycleError {
  return (
    error instanceof ProviderAttemptLifecycleError && error.reason !== 'control_plane_unavailable'
  );
}

export function providerOperationIdForInvocation(anchor?: string): string {
  const parsed = ProviderOperationId.safeParse(anchor);
  if (parsed.success) return parsed.data;
  if (anchor === undefined) return randomUUID();
  if (anchor.trim().length === 0) throw new TypeError('durable operation anchor must be nonblank');
  const bytes = createHash('sha256')
    .update('the-learning-project/provider-operation/v1\0')
    .update(anchor)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return ProviderOperationId.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

export function createDirectProviderOperationContext(
  input: DirectProviderOperationOptions,
): DirectProviderOperationContext {
  return {
    db: input.db,
    caller: input.caller,
    mode: input.mode,
    policy: input.policy,
    env: input.env ?? process.env,
    deadlineAt: input.deadlineAt,
    operationId: providerOperationIdForInvocation(input.operationAnchor),
    createLifecycle: input.createLifecycle,
  };
}

function makeLifecycle(
  context: DirectProviderOperationContext,
  descriptor: DirectProviderAttemptDescriptor,
): ProviderAttemptLifecycle {
  const configured =
    context.mode === undefined
      ? resolveProviderAttemptAdmission(
          context.env ?? process.env,
          ProviderAttemptAdmissionLaneSchema.parse(descriptor.lane),
        )
      : { mode: context.mode, policy: context.policy ?? null };
  const identity = ProviderRequestIdentity.parse({
    attemptId:
      descriptor.attemptAnchor === undefined
        ? randomUUID()
        : providerOperationIdForInvocation(descriptor.attemptAnchor),
    operationId: context.operationId,
    attemptKind: 'wire' as const,
    provider: descriptor.provider,
    model: descriptor.model,
    lane: descriptor.lane,
    protocol: descriptor.protocol,
    endpointClass: descriptor.endpointClass,
    caller: context.caller,
    operationKind: descriptor.operationKind,
  });
  if (context.createLifecycle) {
    return context.createLifecycle({
      mode: configured.mode,
      policy: configured.policy,
      identity,
      deadlineAt: context.deadlineAt,
      db: context.db,
    });
  }
  if (!context.db) throw new TypeError('direct provider attempt context requires db');
  return createProviderAttemptLifecycle({
    mode: configured.mode,
    persistAttemptWhenOff: true,
    policy: configured.policy,
    identity,
    deadlineAt: context.deadlineAt,
    db: context.db,
  });
}

export async function executeDirectProviderAttempt<T>(
  context: DirectProviderOperationContext,
  descriptor: DirectProviderAttemptDescriptor,
  execute: (attempt: DirectProviderAttemptControl) => Promise<T>,
): Promise<DirectProviderAttemptResult<T>> {
  const lifecycle = makeLifecycle(context, descriptor);
  const handle = await lifecycle.acquire();
  await handle.reserveProviderStart();

  let usage: ProviderAttemptUsageTruth = {
    basis: 'unknown',
    unit: 'tokens',
    input: null,
    output: null,
    total: null,
    source: 'provider_response_absent',
  };
  let cost: ProviderAttemptCostTruth = {
    basis: 'unknown',
    amount: null,
    currency:
      descriptor.unknownCostCurrency === null
        ? null
        : CurrencyCode.parse(descriptor.unknownCostCurrency),
    source: 'provider_cost_absent',
  };
  let terminal: ProviderAttemptTerminal = 'succeeded';
  let reason = 'provider_response_accepted';
  let outcome:
    | { readonly kind: 'success'; readonly value: T }
    | {
        readonly kind: 'failure';
        readonly error: unknown;
      };

  const control: DirectProviderAttemptControl = {
    attemptId: lifecycle.identity.attemptId,
    recordExternalRequestId: (id) => handle.recordExternalRequestId(id),
    reportUsage: (reported) => {
      usage = {
        basis: 'reported',
        unit: 'tokens',
        input: reported.input,
        output: reported.output,
        total: reported.total,
        source: 'provider_response',
      };
    },
    estimateCost: (estimated) => {
      cost = {
        basis: 'estimated',
        amount: estimated.amount,
        currency: CurrencyCode.parse(estimated.currency),
        source: estimated.source,
      };
    },
    markTerminal: (nextTerminal, nextReason) => {
      terminal = nextTerminal;
      reason = nextReason;
    },
  };

  try {
    outcome = { kind: 'success', value: await execute(control) };
  } catch (error) {
    outcome = { kind: 'failure', error };
    if (terminal === 'succeeded') {
      terminal = 'failed';
      reason = 'provider_attempt_failed';
    }
  }

  await handle.finish({ terminal, reason, wireCount: 1, usage, cost });

  if (outcome.kind === 'failure') throw outcome.error;
  return { value: outcome.value, attemptId: lifecycle.identity.attemptId };
}
