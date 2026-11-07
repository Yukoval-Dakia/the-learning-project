// Batch-confirm eligibility port (YUK-2009).
//
// The set of batch-confirmable kinds is derived from the composed proposal
// lifecycle registry (B-strength with an owner retract path). Kernel cannot
// import a capability manifest, so the composition root installs the set once
// per process; inbox projections read it to mark `batch_confirm_eligible`
// without letting any caller compute its own whitelist.

import { installHostOperation, installedHostOperation } from '@/kernel/host-operation';

/** Anchor event action: one batch-confirm run's durable batch_id -> proposal_ids mapping. */
export const PROPOSAL_BATCH_ACCEPT_ACTION = 'experimental:proposal_batch_accept';

const SLOT = 'kernel/proposals/batch-confirm:eligible-kinds';

export function installBatchConfirmEligibleKinds(kinds: readonly string[]): void {
  installHostOperation(SLOT, new Set(kinds));
}

/** Read-side gate: an uninstalled set means nothing is batch-confirmable — fail closed, never a 500. */
export function batchConfirmEligibleKind(kind: string): boolean {
  return installedHostOperation<ReadonlySet<string>>(SLOT)?.has(kind) ?? false;
}
