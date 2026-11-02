import type { Db } from '@/db/client';

export type BackupConfigHydrator = (db: Db) => Promise<unknown>;

let hydrator: BackupConfigHydrator | undefined;

/** Injected by the API composition root, which owns the config store restore must re-read. */
export function setBackupConfigHydrator(source: BackupConfigHydrator): void {
  hydrator = source;
}

export function getBackupConfigHydrator(): BackupConfigHydrator | undefined {
  return hydrator;
}
