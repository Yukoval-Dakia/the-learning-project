import type { z } from 'zod';
import type { ConfigMutation } from '@/core/config/mutations';
import type { AdminConfigWriteResponseSchema } from '../api/admin-config-write-contracts';

/** snapshot_current means this process has observed the commit or later, not a worker acknowledgement. */
export type AdminConfigWriteResult = z.infer<typeof AdminConfigWriteResponseSchema>;

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
