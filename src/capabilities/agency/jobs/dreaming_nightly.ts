import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import { planJobProviderWait, providerWaitOutput } from '@/server/ai/provider-wait';
import { runCurator } from '../context/curator';

export function buildDreamingNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<Record<string, unknown> | undefined> {
  return async () => {
    try {
      await runCurator(db, 'nightly');
    } catch (err) {
      // Provable transient provider rejection → ask the DAG for a recovery wait
      // instead of burning the node's retries inside a known outage.
      const wait = await planJobProviderWait(db, err);
      if (wait) {
        return providerWaitOutput({
          retryClass: wait.retryClass,
          detail: `evidence=${wait.evidenceRef}`,
        });
      }
      throw err;
    }
  };
}
