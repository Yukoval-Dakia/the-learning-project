import { z } from 'zod';

export const PROVIDER_ATTEMPT_ADMISSION_LANES = [
  'dashscope.embedding',
  'glm.knowledge-edge-reconcile',
  'glm.memory-reconcile',
  'glm.ocr-layout-parsing',
  'mem0.event-memory',
  'tencent.question-mark-agent',
] as const;

export type ProviderAttemptAdmissionLane = (typeof PROVIDER_ATTEMPT_ADMISSION_LANES)[number];
export type ProviderAttemptAdmissionMode = 'off' | 'observe' | 'enforce';

export type ProviderAttemptAdmissionPolicy = {
  readonly maxConcurrentAttempts: number;
  readonly maxAttemptStartsPerMinute: number;
};

export type ResolvedProviderAttemptAdmission = {
  readonly mode: ProviderAttemptAdmissionMode;
  readonly policy: ProviderAttemptAdmissionPolicy | null;
};

const ModeSchema = z.enum(['off', 'observe', 'enforce']);
export const ProviderAttemptAdmissionLaneSchema = z.enum(PROVIDER_ATTEMPT_ADMISSION_LANES);
const PolicySchema = z
  .object({
    maxConcurrentAttempts: z.number().int().positive(),
    maxAttemptStartsPerMinute: z.number().int().positive(),
  })
  .strict();
const PoliciesSchema = z
  .object({
    'dashscope.embedding': PolicySchema.optional(),
    'glm.knowledge-edge-reconcile': PolicySchema.optional(),
    'glm.memory-reconcile': PolicySchema.optional(),
    'glm.ocr-layout-parsing': PolicySchema.optional(),
    'mem0.event-memory': PolicySchema.optional(),
    'tencent.question-mark-agent': PolicySchema.optional(),
  })
  .strict();

export function resolveProviderAttemptAdmission(
  env: NodeJS.ProcessEnv,
  lane: ProviderAttemptAdmissionLane,
): ResolvedProviderAttemptAdmission {
  const rawMode = env.AI_PROVIDER_ATTEMPT_ADMISSION_MODE?.trim();
  const mode = rawMode === undefined || rawMode === '' ? 'off' : ModeSchema.parse(rawMode);
  if (mode === 'off') return { mode: 'off', policy: null };
  const rawPolicies = env.AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON?.trim();
  if (rawPolicies === undefined || rawPolicies === '') return { mode: 'off', policy: null };
  const policies = PoliciesSchema.parse(JSON.parse(rawPolicies));
  const policy = policies[lane];
  if (policy === undefined) return { mode: 'off', policy: null };
  return { mode, policy };
}
