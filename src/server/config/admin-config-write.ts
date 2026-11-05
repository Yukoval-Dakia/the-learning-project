import type {
  AdminConfigTaskEffectiveBinding,
  AdminConfigWriter,
} from '@/capabilities/observability/public';
import { type TaskKind, tasks } from '@/capabilities/task-registry';
import { getConfigSnapshotEpoch } from '@/core/config/store';
import { type Db, db as defaultDb } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { resolveAdminGlobalEffective, resolveAdminTaskEffective } from './admin-config-facts';
import { mutateConfigs } from './write';

export function createAdminConfigWriter(db: Db = defaultDb): AdminConfigWriter {
  return async (mutations, note) => {
    if (mutations.length === 0)
      throw new ApiError('empty_config_batch', 'No changes supplied', 400);
    const changes = await mutateConfigs(mutations, { actor: 'panel:admin', note }, db);
    const committedEpoch = changes[0].epoch;
    const snapshotEpoch = getConfigSnapshotEpoch();
    // YUK-1808 — the page needs "what actually applies now", not the stored
    // override rows: re-resolve every touched scope through the same resolvers
    // the runtime uses, post-hydrate. A stale snapshot is reported by
    // snapshot_current; this projection then shows what THIS process will run.
    const taskKinds = new Set<TaskKind>();
    let globalTouched = false;
    for (const mutation of mutations) {
      const taskScope = /^task\.([^.]+)\./.exec(mutation.key)?.[1];
      if (taskScope !== undefined && Object.hasOwn(tasks, taskScope))
        taskKinds.add(taskScope as TaskKind);
      if (mutation.key.startsWith('lane.global.')) globalTouched = true;
    }
    if (globalTouched) for (const kind of Object.keys(tasks)) taskKinds.add(kind as TaskKind);
    const effectiveTasks: Record<string, AdminConfigTaskEffectiveBinding> = {};
    for (const kind of taskKinds) effectiveTasks[kind] = resolveAdminTaskEffective(kind);
    return {
      committed_epoch: committedEpoch,
      snapshot_epoch: snapshotEpoch,
      snapshot_current: snapshotEpoch >= committedEpoch,
      changes,
      effective: {
        tasks: effectiveTasks,
        global: globalTouched ? resolveAdminGlobalEffective() : null,
      },
    };
  };
}
