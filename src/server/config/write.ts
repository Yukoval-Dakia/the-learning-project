// YUK-1007 — 配置写面（server-only）。grounding §1.4/§6.3：
//   setConfig(key, value, {actor, note?})  — 单 key upsert + journal + epoch 同 tx，
//                                            commit 后即时 hydrate（本进程 0 延迟）。
//   clearConfig(key, {actor, note?})       — 删行（=「恢复默认」按钮落点），
//                                            journal action='clear'。
//   setConfigs(entries, {actor, note?})    — 多 key 原子写（同 tx 多行 upsert +
//                                            一次 epoch bump）——task.<kind> 组写
//                                            provider+model 需要它。
//
// 校验先于 tx（§6.3）：未登记 key → 400；pinned（compose 强制）→ 409；zod
// schema 拒绝 → 422 + issues；provider/lane 写带谓词校验（isKnownProvider /
// isProviderImplemented(ForTask) / providerRequiresExplicitModel——读端 fail-open
// 降级的镜像，写端 fail-closed 拦下不可跑组合，§1.4/§2.2）。
//
// 并发（§6.3）：行级 upsert + journal + epoch 同 tx；两进程同 key 写 = 最后一次
// 赢，journal 双方都在（PK(key,revision) 无碰撞）。无 CAS——单用户 admin 面不
// 需要（可选 expectedRevision 列为后续增强）。

import { eq, sql } from 'drizzle-orm';
import type { TaskKind } from '@/ai/registry';
import { tasks } from '@/ai/registry';
import type { ConfigValue } from '@/core/config/store';
import { getConfig, resolveKeyDef } from '@/core/config/store';
import { type Db, type Tx, db as defaultDb } from '@/db/client';
import { system_config, system_config_journal } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import {
  type Provider,
  isKnownProvider,
  isProviderImplemented,
  isProviderImplementedForTask,
  providerRequiresExplicitModel,
} from '@/server/ai/providers';
import { hydrateConfigFromDb } from './hydrate';

export type ConfigActor = 'owner' | 'panel:admin' | 'migrate' | 'cli';

const EPOCH_ROW_ID = 'global';

export interface ConfigWriteResult {
  key: string;
  revision: number;
  epoch: number;
}

/** 校验一个 key/value 对。never-throws 在写面不适用——非法写直接 ApiError。 */
function validateEntry(
  key: string,
  value: ConfigValue,
  batch: ReadonlyMap<string, ConfigValue>,
): { schema: { safeParse(v: unknown): { success: boolean; error?: { issues: unknown[] } } } } {
  const def = resolveKeyDef(key);
  if (!def) {
    throw new ApiError(
      'unknown_config_key',
      `config key '${key}' is not registered in CONFIG_REGISTRY (and does not match task.*/lane.* patterns)`,
      400,
    );
  }
  if ((def.envMode ?? 'fallback') === 'pinned') {
    throw new ApiError(
      'config_key_compose_pinned',
      `config key '${key}' is compose-forced (envPinned): ${def.envName} must be set at deploy level — DB writes would silently lose to the pin`,
      409,
    );
  }
  const parsed = def.schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(
      'invalid_config_value',
      `config key '${key}' failed schema validation: ${JSON.stringify(parsed.error.issues.slice(0, 5))}`,
      422,
    );
  }
  validateProviderSemantics(key, parsed.data as ConfigValue, batch);
  return { schema: def.schema };
}

/** provider/model 组合约束（写端 422 拦下，§1.4/§2.2 —— 读端保持 throw/degrade 兜底）。 */
function validateProviderSemantics(
  key: string,
  value: ConfigValue,
  batch: ReadonlyMap<string, ConfigValue>,
): void {
  // JUDGE_FALLBACK_PROVIDER：'' = 显式关（合法）；非空必须是已知 + implemented
  // + 可裸跑（该 lane 不递 model）。
  if (key === 'JUDGE_FALLBACK_PROVIDER') {
    if (typeof value !== 'string' || value === '') return;
    if (!isKnownProvider(value) || !isProviderImplemented(value)) {
      throw new ApiError(
        'invalid_config_value',
        `JUDGE_FALLBACK_PROVIDER='${value}' is not a wired provider`,
        422,
      );
    }
    if (providerRequiresExplicitModel(value)) {
      throw new ApiError(
        'invalid_config_value',
        `JUDGE_FALLBACK_PROVIDER='${value}' requires an explicit model which the fallback lane never supplies — it would resolve to the registry mimo id and 404`,
        422,
      );
    }
    return;
  }

  // task.<kind>.provider / lane.<lane>.provider：kind/lane 存在性 + provider 可用性
  // + requiresExplicitModel 时同批/既有 model 必须在场。
  const m = /^task\.([^.]+)\.provider$/.exec(key) ?? /^lane\.([^.]+)\.provider$/.exec(key);
  if (!m) return;
  if (typeof value !== 'string' || value === '') return; // 空 provider 走 clear
  const scope = m[1];
  const isTask = key.startsWith('task.');
  if (isTask && !(scope in tasks)) {
    throw new ApiError(
      'unknown_config_key',
      `task kind '${scope}' is not in the TaskSpec registry`,
      400,
    );
  }
  if (!isKnownProvider(value)) {
    throw new ApiError('invalid_config_value', `${key}='${value}' is not a known provider`, 422);
  }
  const provider = value as Provider;
  const implemented = isTask
    ? isProviderImplementedForTask(provider, scope as TaskKind)
    : isProviderImplemented(provider);
  if (!implemented) {
    throw new ApiError(
      'invalid_config_value',
      `${key}='${provider}' is reserved but not implemented for ${isTask ? `task '${scope}'` : `lane '${scope}'`}`,
      422,
    );
  }
  if (providerRequiresExplicitModel(provider)) {
    const modelKey = `${isTask ? 'task' : 'lane'}.${scope}.model`;
    const inBatch = batch.get(modelKey);
    const effective = typeof inBatch === 'string' && inBatch !== '' ? inBatch : getConfig(modelKey);
    if (typeof effective !== 'string' || effective === '') {
      throw new ApiError(
        'invalid_config_value',
        `${key}='${provider}' requires an explicit model (set '${modelKey}' in the same write or beforehand)`,
        422,
      );
    }
  }
}

export interface ConfigWriteOptions {
  actor: ConfigActor;
  note?: string;
}

async function bumpEpoch(tx: Tx): Promise<number> {
  // INSERT … ON CONFLICT 幂等首行；每次写 nextval(config_change_seq)——与
  // journal.change_seq 同序列（§1.2「config_change_seq 同序列」）。
  const rows = await tx.execute(sql`
    insert into system_config_epoch (id, epoch, updated_at)
    values (${EPOCH_ROW_ID}, nextval('config_change_seq'), now())
    on conflict (id) do update set epoch = nextval('config_change_seq'), updated_at = now()
    returning epoch
  `);
  const row = (rows as unknown as Array<{ epoch: number | string }>)[0];
  return typeof row.epoch === 'string' ? Number(row.epoch) : row.epoch;
}

/** 单 key 写。commit 后即时 hydrate（写进程 0 延迟生效，§6.2 self-read）。 */
export async function setConfig(
  key: string,
  value: ConfigValue,
  opts: ConfigWriteOptions,
  db: Db = defaultDb,
): Promise<ConfigWriteResult> {
  const results = await setConfigs([{ key, value }], opts, db);
  // entries 非空已在上游 gate；results[0] 恒在。
  const first = results[0];
  if (!first) throw new Error('setConfig: empty result for non-empty write');
  return first;
}

/** 多 key 原子写（同 tx 行级 upsert + journal + 一次 epoch bump）。 */
export async function setConfigs(
  entries: ReadonlyArray<{ key: string; value: ConfigValue }>,
  opts: ConfigWriteOptions,
  db: Db = defaultDb,
): Promise<ConfigWriteResult[]> {
  if (entries.length === 0) return [];
  const batch = new Map(entries.map((e) => [e.key, e.value]));
  for (const { key, value } of entries) validateEntry(key, value, batch);

  const now = new Date();
  const results = await db.transaction(async (tx) => {
    const epoch = await bumpEpoch(tx);
    const out: ConfigWriteResult[] = [];
    for (const { key, value } of entries) {
      const prev = await tx
        .select()
        .from(system_config)
        .where(eq(system_config.key, key))
        .for('update')
        .limit(1);
      const prevRow = prev[0];
      const revision = (prevRow?.revision ?? 0) + 1;
      if (prevRow) {
        await tx
          .update(system_config)
          .set({
            value,
            revision,
            source_note: opts.note ?? prevRow.source_note,
            updated_by: opts.actor,
            updated_at: now,
          })
          .where(eq(system_config.key, key));
      } else {
        await tx.insert(system_config).values({
          key,
          value,
          revision,
          source_note: opts.note ?? null,
          updated_by: opts.actor,
          created_at: now,
          updated_at: now,
        });
      }
      await tx.insert(system_config_journal).values({
        key,
        revision,
        payload: { prev: prevRow?.value ?? null, next: value, note: opts.note ?? null },
        action: 'set',
        actor: opts.actor,
        created_at: now,
      });
      out.push({ key, revision, epoch });
    }
    return out;
  });

  await hydrateConfigFromDb(db); // 本进程即时生效；他进程 ≤15s 经 refresh 收敛
  return results;
}

/** 删除行 = 回退 env/default。journal 留 clear 快照（prev + note）。 */
export async function clearConfig(
  key: string,
  opts: ConfigWriteOptions,
  db: Db = defaultDb,
): Promise<{ key: string; cleared: boolean; epoch: number }> {
  const def = resolveKeyDef(key);
  if (!def) {
    throw new ApiError('unknown_config_key', `config key '${key}' is not registered`, 400);
  }
  if ((def.envMode ?? 'fallback') === 'pinned') {
    throw new ApiError(
      'config_key_compose_pinned',
      `config key '${key}' is compose-forced — nothing to clear (DB writes never take effect)`,
      409,
    );
  }

  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const epoch = await bumpEpoch(tx);
    const prev = await tx
      .select()
      .from(system_config)
      .where(eq(system_config.key, key))
      .for('update')
      .limit(1);
    const prevRow = prev[0];
    if (prevRow) {
      await tx.delete(system_config).where(eq(system_config.key, key));
    }
    await tx.insert(system_config_journal).values({
      key,
      revision: (prevRow?.revision ?? 0) + 1,
      payload: { prev: prevRow?.value ?? null, next: null, note: opts.note ?? null },
      action: 'clear',
      actor: opts.actor,
      created_at: now,
    });
    return { key, cleared: Boolean(prevRow), epoch };
  });

  await hydrateConfigFromDb(db);
  return result;
}
