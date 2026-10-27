import type { Tx } from '@/db/client';
import { fromPgBossDrizzleTx } from '@/db/pg-boss-drizzle';
import { getRunningBoss, getStartedBoss } from '@/server/boss/client';

export async function getNotesBoss() {
  return getStartedBoss();
}

export function getRunningNotesBoss() {
  return getRunningBoss();
}

export function notesBossTransaction(tx: Tx) {
  return fromPgBossDrizzleTx(tx);
}
