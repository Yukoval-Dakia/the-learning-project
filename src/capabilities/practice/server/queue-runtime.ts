import type { Tx } from '@/db/client';
import { fromPgBossDrizzleTx } from '@/db/pg-boss-drizzle';
import { getStartedBoss } from '@/server/boss/client';
import { WORKSHEET_RENDER_QUEUE } from '../worksheet-render-queue';

/** Capability-local durable-queue runtime boundary. */
export function getPracticeBoss(): ReturnType<typeof getStartedBoss> {
  return getStartedBoss();
}

export function practiceBossTransaction(tx: Tx): ReturnType<typeof fromPgBossDrizzleTx> {
  return fromPgBossDrizzleTx(tx);
}

/** Request rendering for an already committed export; submission owns recovery and errors. */
export async function enqueueWorksheetRender(exportToken: string): Promise<void> {
  const boss = await getPracticeBoss();
  await boss.send(WORKSHEET_RENDER_QUEUE, { export_token: exportToken });
}
