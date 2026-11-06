import type { Tx } from '@/db/client';
import {
  HostOperationNotInstalledError,
  installHostOperation,
  installedHostOperation,
} from '@/kernel/host-operation';

// The host owns cascade traversal and installs it before settlement can replay.
type SettlementCascadeRevert = (
  tx: Tx,
  checkpointEventId: string,
  options: { reasonContext: { note: string } },
) => Promise<{ ok: true } | { ok: false; refusal: string; reason: string }>;

const REVERT_SLOT = 'kernel/settlement-cascade-revert:revert';

export function installSettlementCascadeRevert(revert: SettlementCascadeRevert): void {
  installHostOperation(REVERT_SLOT, revert);
}

export function orchestrateCascadeRevert(
  ...args: Parameters<SettlementCascadeRevert>
): ReturnType<SettlementCascadeRevert> {
  const revert = installedHostOperation<SettlementCascadeRevert>(REVERT_SLOT);
  if (!revert) {
    throw new HostOperationNotInstalledError(
      'settlement cascade revert is not installed; call installSettlementCascadeRevert at startup',
    );
  }
  return revert(...args);
}
