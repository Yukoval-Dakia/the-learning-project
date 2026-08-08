import type { Tx } from '@/db/client';
import { getStartedBoss } from '@/server/boss/client';
import { fromPgBossDrizzleTx } from '@/server/boss/pg-boss-drizzle';

/** Capability-local durable-queue runtime boundary. */
export function getPracticeBoss(): ReturnType<typeof getStartedBoss> {
  return getStartedBoss();
}

export function practiceBossTransaction(tx: Tx): ReturnType<typeof fromPgBossDrizzleTx> {
  return fromPgBossDrizzleTx(tx);
}
