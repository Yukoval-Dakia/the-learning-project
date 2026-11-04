import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import { runCurator } from '../context/curator';

export async function runDreamingNightly(db: Db) {
  return runCurator(db, 'nightly');
}

export function buildDreamingNightlyHandler(db: Db): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => { await runDreamingNightly(db); };
}
