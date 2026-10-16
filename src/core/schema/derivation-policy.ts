import { z } from 'zod';

export const DerivationPolicy = z.enum(['allow', 'answer_only']);
export type DerivationPolicyT = z.infer<typeof DerivationPolicy>;
const PolicyPayload = z.object({ derivation_policy: DerivationPolicy.optional() });

/**
 * Absence preserves legacy behavior. Invalid explicit policies never become
 * allow: safeParse + fail CLOSED to the strictest value (YUK-1408 / R1 P2-4 —
 * the SQL predicate treats any non-'allow' literal as restricted, so a
 * malformed payload would otherwise throw a 500 on the TS path while SQL
 * quietly excludes it; both paths now agree). If the enum ever widens beyond
 * 'allow' | 'answer_only', the strictest representative must be updated here
 * too.
 */
export function readDerivationPolicy(payload: unknown): DerivationPolicyT {
  const parsed = PolicyPayload.safeParse(payload ?? {});
  if (!parsed.success) return 'answer_only';
  return parsed.data.derivation_policy ?? 'allow';
}

export function allowsDerivation(payload: unknown): boolean {
  const parsed = PolicyPayload.safeParse(payload ?? {});
  return parsed.success && (parsed.data.derivation_policy ?? 'allow') === 'allow';
}
