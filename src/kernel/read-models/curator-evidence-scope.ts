// Curator-evidence-scope host port. Agency owns the rule that decides which
// events a Curator run may treat as evidence (derivation policy ∩ learner
// evidence ∩ user-actor ∩ action allowlist ∩ withdrawal exclusion ∩ run-anchor
// window) in `capabilities/agency/context/curator-evidence.ts`; kernel cannot
// import a capability, so the scope producer is installed at startup — same
// shape as the memory-brief port. Callers must not re-implement the rule.

import type { SQL } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import {
  HostOperationNotInstalledError,
  installHostOperation,
  installedHostOperation,
} from '@/kernel/host-operation';

/**
 * Returns a WHERE fragment restricting an `event`-table read to the evidence
 * window of the Curator run anchored at `anchorId`. Shared by the canonical
 * evidence reader and tools that must not exceed that window.
 */
export type CuratorEvidenceScope = (db: Db | Tx, anchorId: string | undefined) => Promise<SQL>;

const SCOPE_SLOT = 'kernel/read-models/curator-evidence-scope:scope';

export function installCuratorEvidenceScope(scope: CuratorEvidenceScope): void {
  installHostOperation(SCOPE_SLOT, scope);
}

/**
 * The one curator-evidence scope for non-agency consumers. A missing install is
 * a host wiring defect, not a read failure — callers that degrade on errors
 * must rethrow HostOperationNotInstalledError rather than hide it.
 */
export async function curatorEvidenceScope(
  db: Db | Tx,
  anchorId: string | undefined,
): Promise<SQL> {
  const scope = installedHostOperation<CuratorEvidenceScope>(SCOPE_SLOT);
  if (!scope) {
    throw new HostOperationNotInstalledError(
      'curator evidence scope is not installed; call installAgencyHostOperations at startup',
    );
  }
  return scope(db, anchorId);
}
