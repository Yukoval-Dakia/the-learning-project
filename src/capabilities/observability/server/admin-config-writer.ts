import type { ConfigMutation, ConfigMutationResult } from '@/core/config/mutations';

export interface AdminConfigWriteResult {
  committed_epoch: number;
  snapshot_epoch: number;
  /** This process has observed the commit or a later version; not a worker acknowledgement. */
  snapshot_current: boolean;
  changes: ConfigMutationResult[];
}

export type AdminConfigWriter = (
  mutations: readonly ConfigMutation[],
  note?: string,
) => Promise<AdminConfigWriteResult>;

let writer: AdminConfigWriter | undefined;

/** Injected by the API composition root; this port only accepts registered config mutations. */
export function setAdminConfigWriter(source: AdminConfigWriter): void {
  writer = source;
}

export function getAdminConfigWriter(): AdminConfigWriter | undefined {
  return writer;
}

export function __resetAdminConfigWriterForTests(): void {
  writer = undefined;
}
