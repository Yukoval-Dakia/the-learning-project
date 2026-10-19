// Written when an effect is dispatched under the completion-receipt contract.
// Rows without it predate the contract and carry no completion fact, so import
// cannot infer that their downstream work is still outstanding.
export const DOWNSTREAM_COMPLETION_CONTRACT = 'event-subscription-effect/v1';

export function hasCompletionContract(outcome: unknown): boolean {
  if (typeof outcome !== 'object' || outcome === null || Array.isArray(outcome)) return false;
  return (
    (outcome as Record<string, unknown>).completion_contract === DOWNSTREAM_COMPLETION_CONTRACT
  );
}
