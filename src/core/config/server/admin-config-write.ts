// YUK-1808 — 管理写面适配器（配置 owner）：把面板提交的 mutation 走同一条
// mutateConfigs 事务，并在提交后按运行时同一 resolver 返回本次触碰 scope 的
// effective 值。任务/lane 事实与 effective 解析由组合根经 AdminConfigWriterPorts
// 注入；配置不 import observability，也不 import AI/capability 实现。

import { getConfigSnapshotEpoch } from '@/core/config/store';
import { type Db, db as defaultDb } from '@/db/client';
import { ApiError } from '@/kernel/http';
import type {
  AdminConfigTaskEffectiveBinding,
  AdminConfigWriter,
  AdminConfigWriterPorts,
} from '../contracts/admin';
import { mutateConfigs } from './write';

export function createAdminConfigWriter(
  ports: AdminConfigWriterPorts,
  db: Db = defaultDb,
): AdminConfigWriter {
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
    const taskKinds = new Set<string>();
    let globalTouched = false;
    for (const mutation of mutations) {
      const taskScope = /^task\.([^.]+)\./.exec(mutation.key)?.[1];
      if (taskScope !== undefined && ports.hasTask(taskScope)) taskKinds.add(taskScope);
      // A scoped-lane write changes every task the lane serves — project them all.
      if (/^lane\.vision_judge\.(provider|model)$/.test(mutation.key))
        for (const kind of ports.visionJudgeTaskKinds) taskKinds.add(kind);
      if (/^lane\.verify_solve\.(provider|model)$/.test(mutation.key))
        for (const kind of ports.solveLaneTaskKinds) taskKinds.add(kind);
      if (mutation.key.startsWith('lane.global.')) globalTouched = true;
    }
    if (globalTouched) for (const kind of ports.taskKinds) taskKinds.add(kind);
    const effectiveTasks: Record<string, AdminConfigTaskEffectiveBinding> = {};
    for (const kind of taskKinds) effectiveTasks[kind] = ports.resolveTaskEffective(kind);
    return {
      committed_epoch: committedEpoch,
      snapshot_epoch: snapshotEpoch,
      snapshot_current: snapshotEpoch >= committedEpoch,
      changes,
      effective: {
        tasks: effectiveTasks,
        global: globalTouched ? ports.resolveGlobalEffective() : null,
      },
    };
  };
}
