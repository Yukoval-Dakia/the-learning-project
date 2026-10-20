export const DOWNSTREAM_COMPLETION_CONTRACT = 'event-subscription-effect/v1';

export function readCompletionContract(
  outcome: unknown,
): { kind: 'legacy' } | { kind: 'invalid' } | { kind: 'v1'; status: unknown } {
  if (outcome === null || outcome === undefined) return { kind: 'legacy' };
  if (typeof outcome !== 'object' || Array.isArray(outcome)) return { kind: 'invalid' };
  if (!('completion_contract' in outcome)) return { kind: 'legacy' };
  if (outcome.completion_contract !== DOWNSTREAM_COMPLETION_CONTRACT) return { kind: 'invalid' };
  return { kind: 'v1', status: 'status' in outcome ? outcome.status : undefined };
}
