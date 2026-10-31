// Practice owns diagnostic-question materialization. Archive recovery calls
// this port so that job does not import the practice capability. The worker
// binds the practice implementation before the recovery job mounts. The call
// object is forwarded intact.

import type {
  InterventionPackageT,
  InterventionSettlementT,
  InterventionSnapshotT,
} from '@/core/schema/intervention';
import type { Tx } from '@/db/client';

export interface MaterializeInterventionDiagnosticsInput {
  package: InterventionPackageT;
  settlement: InterventionSettlementT;
  snapshot: InterventionSnapshotT;
  now: Date;
}

export type MaterializeInterventionDiagnostics = (
  tx: Tx,
  input: MaterializeInterventionDiagnosticsInput,
) => Promise<void>;

let boundMaterializer: MaterializeInterventionDiagnostics | undefined;

export function bindMaterializeInterventionDiagnostics(
  materializer: MaterializeInterventionDiagnostics,
): void {
  boundMaterializer = materializer;
}

export async function materializeInterventionDiagnostics(
  tx: Tx,
  input: MaterializeInterventionDiagnosticsInput,
): Promise<void> {
  const materializer = boundMaterializer;
  if (!materializer) {
    throw new Error(
      'intervention diagnostic materializer is not installed; call installInterventionDiagnosticMaterializer before intervention_prepare_recovery',
    );
  }
  return materializer(tx, input);
}
