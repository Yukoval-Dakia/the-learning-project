import type { ProposalLifecycleResult } from '@/kernel/proposals';

export function assertProposalLifecycleResult<Result extends { readonly kind: string }>(
  result: ProposalLifecycleResult,
  kind: Result['kind'],
): asserts result is ProposalLifecycleResult & Result {
  if (result.kind !== kind) {
    throw new Error(`expected proposal lifecycle result ${kind}, received ${result.kind}`);
  }
}
