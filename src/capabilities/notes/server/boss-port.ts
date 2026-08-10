import type { Tx } from '@/db/client';
import { getRunningBoss, getStartedBoss } from '@/server/boss/client';
import { fromPgBossDrizzleTx } from '@/server/boss/pg-boss-drizzle';

export async function getNotesBoss() {
  return getStartedBoss();
}

export function getRunningNotesBoss() {
  return getRunningBoss();
}

export function notesBossTransaction(tx: Tx) {
  return fromPgBossDrizzleTx(tx);
}
