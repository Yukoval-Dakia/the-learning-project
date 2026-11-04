import { z } from 'zod';

const NonblankString = z.string().refine((value) => value.trim().length > 0, {
  message: 'must be nonblank',
});
const OptionalNonblankString = z.union([NonblankString, z.null()]);
const UsageValue = z.number().finite().nonnegative().nullable();
export const CurrencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .brand<'CurrencyCode'>();
export type CurrencyCode = z.infer<typeof CurrencyCode>;

export const ProviderAttemptId = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
  .brand<'ProviderAttemptId'>();
export type ProviderAttemptId = z.infer<typeof ProviderAttemptId>;

export const ProviderOperationId = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
  .brand<'ProviderOperationId'>();
export type ProviderOperationId = z.infer<typeof ProviderOperationId>;

export const ProviderAttemptKind = z.enum(['wire', 'opaque_operation']);
export type ProviderAttemptKind = z.infer<typeof ProviderAttemptKind>;

export const ProviderAttemptCaller = z.enum(['api', 'worker']);
export type ProviderAttemptCaller = z.infer<typeof ProviderAttemptCaller>;

export const ProviderRequestIdentity = z
  .object({
    attemptId: ProviderAttemptId,
    operationId: ProviderOperationId,
    attemptKind: ProviderAttemptKind,
    provider: NonblankString,
    model: OptionalNonblankString,
    lane: NonblankString,
    protocol: NonblankString,
    endpointClass: NonblankString,
    caller: ProviderAttemptCaller,
    operationKind: NonblankString,
    externalRequestId: NonblankString.optional(),
  })
  .strict()
  .readonly();
export type ProviderRequestIdentity = z.infer<typeof ProviderRequestIdentity>;

const KnownProviderAttemptUsage = z
  .object({
    basis: z.enum(['reported', 'estimated']),
    unit: NonblankString,
    input: UsageValue,
    output: UsageValue,
    total: UsageValue,
    source: NonblankString,
  })
  .strict()
  .refine((usage) => usage.input !== null || usage.output !== null || usage.total !== null, {
    message: 'known usage requires at least one numeric value',
  })
  .readonly();

const UnknownProviderAttemptUsage = z
  .object({
    basis: z.literal('unknown'),
    unit: OptionalNonblankString,
    input: z.null(),
    output: z.null(),
    total: z.null(),
    source: NonblankString,
  })
  .strict()
  .readonly();

export const ProviderAttemptUsageTruth = z.union([
  KnownProviderAttemptUsage,
  UnknownProviderAttemptUsage,
]);
export type ProviderAttemptUsageTruth = z.infer<typeof ProviderAttemptUsageTruth>;

const KnownProviderAttemptCost = z
  .object({
    basis: z.enum(['reported', 'estimated']),
    amount: z.number().finite().nonnegative(),
    currency: CurrencyCode,
    source: NonblankString,
  })
  .strict()
  .readonly();

const UnknownProviderAttemptCost = z
  .object({
    basis: z.literal('unknown'),
    amount: z.null(),
    currency: CurrencyCode.nullable(),
    source: NonblankString,
  })
  .strict()
  .readonly();

export const ProviderAttemptCostTruth = z.union([
  KnownProviderAttemptCost,
  UnknownProviderAttemptCost,
]);
export type ProviderAttemptCostTruth = z.infer<typeof ProviderAttemptCostTruth>;

export const ProviderAttemptTerminal = z.enum(['succeeded', 'failed', 'aborted', 'unknown']);
export type ProviderAttemptTerminal = z.infer<typeof ProviderAttemptTerminal>;

export const ProviderAttemptTerminalEvidence = z
  .object({
    terminal: ProviderAttemptTerminal,
    reason: NonblankString,
    wireCount: z.number().int().nonnegative().nullable(),
    usage: ProviderAttemptUsageTruth,
    cost: ProviderAttemptCostTruth,
  })
  .strict()
  .readonly();
export type ProviderAttemptTerminalEvidence = z.infer<typeof ProviderAttemptTerminalEvidence>;
