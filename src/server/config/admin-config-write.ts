import type { AdminConfigWriter } from '@/capabilities/observability/public';
import { getConfigSnapshotEpoch } from '@/core/config/store';
import { type Db, db as defaultDb } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { mutateConfigs } from './write';

export function createAdminConfigWriter(db: Db = defaultDb): AdminConfigWriter {
  return async (mutations, note) => {
    if (mutations.length === 0)
      throw new ApiError('empty_config_batch', 'No changes supplied', 400);
    const changes = await mutateConfigs(mutations, { actor: 'panel:admin', note }, db);
    const committedEpoch = changes[0].epoch;
    const snapshotEpoch = getConfigSnapshotEpoch();
    return {
      committed_epoch: committedEpoch,
      snapshot_epoch: snapshotEpoch,
      snapshot_current: snapshotEpoch >= committedEpoch,
      changes,
    };
  };
}
