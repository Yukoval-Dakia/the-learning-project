import { z } from 'zod';
import { type ConfigValue, getConfig } from '@/core/config/store';

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

/**
 * Config layering (YUK-1007): DB row > env > 'off'. env carries JSON text; DB
 * stores parsed objects (registry schema checks shape, write.ts checks lane
 * names). Invalid values still throw — admission is a circuit breaker and must
 * not fail open.
 */
function policiesInput(raw: ConfigValue | string | undefined): unknown {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return undefined;
    return JSON.parse(trimmed);
  }
  return raw;
}

export function resolveProviderAttemptAdmission(
  env: NodeJS.ProcessEnv,
  lane: ProviderAttemptAdmissionLane,
): ResolvedProviderAttemptAdmission {
  // The env argument is only the fallback layer for getConfig; a DB row always wins.
  const rawMode = getConfig('AI_PROVIDER_ATTEMPT_ADMISSION_MODE', env);
  const mode = rawMode === undefined || rawMode === '' ? 'off' : ModeSchema.parse(rawMode);
  if (mode === 'off') return { mode: 'off', policy: null };
  const parsed = policiesInput(getConfig('AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON', env));
  if (parsed === undefined) return { mode: 'off', policy: null };
  const policies = PoliciesSchema.parse(parsed);
  const policy = policies[lane];
  if (policy === undefined) return { mode: 'off', policy: null };
  return { mode, policy };
}
