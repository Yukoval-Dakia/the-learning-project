import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import { type WorkspaceSweepReport, sweepAgentWorkspaces } from '../server/sweep';

export function buildAgentWorkspaceSweepHandler(
  db: Db,
): (jobs: Job[]) => Promise<WorkspaceSweepReport> {
  return async () => sweepAgentWorkspaces(db);
}
