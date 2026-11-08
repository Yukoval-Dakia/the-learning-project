import type { AdminConfigWriteResult, AdminConfigWriter } from '@/core/config/contracts/admin';

/** snapshot_current means this process has observed the commit or later, not a worker acknowledgement. */
export type { AdminConfigWriteResult, AdminConfigWriter };

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
