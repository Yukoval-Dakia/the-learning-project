import { z } from 'zod';

export const DerivationPolicy = z.enum(['allow', 'answer_only']);
export type DerivationPolicyT = z.infer<typeof DerivationPolicy>;
const PolicyPayload = z.object({ derivation_policy: DerivationPolicy.optional() });

/** Absence preserves legacy behavior. Invalid explicit policies never become allow. */
export function readDerivationPolicy(payload: unknown): DerivationPolicyT {
  return PolicyPayload.parse(payload ?? {}).derivation_policy ?? 'allow';
}

export function allowsDerivation(payload: unknown): boolean {
  const parsed = PolicyPayload.safeParse(payload ?? {});
  return parsed.success && (parsed.data.derivation_policy ?? 'allow') === 'allow';
}
