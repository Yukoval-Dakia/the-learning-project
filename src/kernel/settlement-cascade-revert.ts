import type { Tx } from '@/db/client';
import { HostOperationNotInstalledError } from '@/kernel/host-operation';

// The host owns cascade traversal and installs it before settlement can replay.
type SettlementCascadeRevert = (
  tx: Tx,
  checkpointEventId: string,
  options: { reasonContext: { note: string } },
) => Promise<{ ok: true } | { ok: false; refusal: string; reason: string }>;

let installedCascadeRevert: SettlementCascadeRevert | undefined;

export function installSettlementCascadeRevert(revert: SettlementCascadeRevert): void {
  installedCascadeRevert = revert;
}

export function orchestrateCascadeRevert(
  ...args: Parameters<SettlementCascadeRevert>
): ReturnType<SettlementCascadeRevert> {
  if (!installedCascadeRevert) {
    throw new HostOperationNotInstalledError(
      'settlement cascade revert is not installed; call installSettlementCascadeRevert at startup',
    );
  }
  return installedCascadeRevert(...args);
}
