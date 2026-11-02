import type { Tx } from '@/db/client';
import { fromPgBossDrizzleTx } from '@/db/pg-boss-drizzle';
import { getStartedBoss } from '@/server/boss/client';

/** Capability-local durable-queue runtime boundary. */
export function getPracticeBoss(): ReturnType<typeof getStartedBoss> {
  return getStartedBoss();
}

export function practiceBossTransaction(tx: Tx): ReturnType<typeof fromPgBossDrizzleTx> {
  return fromPgBossDrizzleTx(tx);
}
