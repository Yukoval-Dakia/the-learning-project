/**
 * YUK-1007 review P1-6 — restore leaves stale runtime.
 *
 * Bug class: restoreFromArchive re-inserted the archived `system_config_epoch`
 * verbatim. If that epoch value coincides with the restoring process's already
 * published epoch (same timeline restarts are the common case — epoch seq is
 * just `config_change_seq`, and a same-DB restore can land an identical number),
 * every hydrate probe sees "unchanged" forever and the running process keeps
 * its pre-restore values.
 *
 * Fix: restore writes a strictly-new epoch at the end of the tx (greater than
 * every epoch this DB lineage ever issued — pre-wipe row, sequence position,
 * and the just-restored archive value — and greater than this process's own
 * snapshot epoch), then immediately re-hydrates post-commit.
 *
 * Deterministic repro (no reliance on sequence reset — TRUNCATE RESTART IDENTITY
 * does not touch the standalone `config_change_seq`):
 *   1. setConfig(111) → snapshot epoch E (whatever the seq issued) → archive.
 *   2. Inject the diverged runtime: publish a snapshot of the SAME epoch E with
 *      value 222 — the exact collision shape (epoch says "same", content says
 *      different).
 *   3. Restore the archive. Pre-fix the archived epoch E lands verbatim →
 *      restore-time hydrate (and every later probe) sees epoch "unchanged" →
 *      runtime keeps 222 forever.
 */
import { sql } from 'drizzle-orm';
import { unzipSync, zipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  type ConfigSnapshot,
  getConfig,
  getConfigSnapshotEpoch,
  replaceConfigSnapshot,
  resetTestConfig,
} from '@/core/config/store';
import { system_config, system_config_epoch } from '@/db/schema';
import { hydrateConfigFromDb } from '@/server/config/hydrate';
import { clearConfig, setConfig, setConfigs } from '@/server/config/write';
import { buildBackupArchive, restoreFromArchive } from '@/server/export/archive';
import { resetDb, testDb } from '../helpers/db';
import { createMem0Collection } from '../helpers/mem0-collection';
import { memR2 } from '../helpers/r2';

const EMPTY_SNAPSHOT: ConfigSnapshot = { epoch: 0, entries: new Map(), hydratedAt: '' };

async function zipBytes(): Promise<Uint8Array> {
  const { stream } = await buildBackupArchive({
    db: testDb(),
    r2: memR2(),
    includeAssets: false,
  });
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

/** 发布一份「epoch 与备份同号、值却已漂移」的运行时快照——撞号的精确形状。 */
function publishDivergedSnapshot(epoch: number, value: number): void {
  replaceConfigSnapshot({
    epoch,
    entries: new Map([
      ['AI_RATE_LIMIT_MAX', { value, revision: 1, updatedAt: new Date().toISOString() }],
    ]),
    hydratedAt: new Date().toISOString(),
  });
}

describe('restoreFromArchive — config epoch (P1-6)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(async () => {
    resetTestConfig();
    replaceConfigSnapshot(EMPTY_SNAPSHOT);
    await resetDb();
  });

  it('restore publishes a strictly-new epoch and the process re-hydrates to archived rows', async () => {
    const db = testDb();

    // Step 1 — archived state: value=111 at epoch E.
    await setConfig('AI_RATE_LIMIT_MAX', 111, { actor: 'cli' }, db);
    const archivedEpoch = getConfigSnapshotEpoch();
    expect(archivedEpoch).toBeGreaterThanOrEqual(1);
    const zip = await zipBytes();

    // Step 2 — diverged runtime at the SAME epoch number (the collision the
    // verbatim-restore bug hides behind).
    publishDivergedSnapshot(archivedEpoch, 222);
    expect(getConfig('AI_RATE_LIMIT_MAX', {})).toBe(222);
    expect(getConfigSnapshotEpoch()).toBe(archivedEpoch);

    // Step 3 — restore. Pre-fix: epoch E lands verbatim, hydrate sees
    // "unchanged" (or never runs), runtime keeps 222.
    const res = await restoreFromArchive({ db, r2: memR2(), bytes: zip });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // Post-fix: strictly-new epoch + post-commit hydrate → 111 is live.
    expect(getConfigSnapshotEpoch()).toBeGreaterThan(archivedEpoch);
    expect(getConfig('AI_RATE_LIMIT_MAX', {})).toBe(111);

    // Durable axis: the epoch row sits strictly above the archived one.
    const [epochRow] = await db.select().from(system_config_epoch);
    expect(epochRow?.epoch).toBeGreaterThan(archivedEpoch);
  });

  it('a second process hydrating post-restore converges (probe cannot skip)', async () => {
    const db = testDb();
    await setConfig('AI_RATE_LIMIT_MAX', 77, { actor: 'cli' }, db);
    const zip = await zipBytes();

    const res = await restoreFromArchive({ db, r2: memR2(), bytes: zip });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // Fresh-process view: empty snapshot → hydrate must publish restored rows.
    replaceConfigSnapshot(EMPTY_SNAPSHOT);
    const rep = await hydrateConfigFromDb(db);
    expect(rep.epochUnchanged).toBe(false);
    expect(getConfig('AI_RATE_LIMIT_MAX', {})).toBe(77);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 第二轮 review P1（两轴去重）—— restore 抬 epoch 后必须同步 config_change_seq
// 高水位。田置：restore 把归档 journal/epoch 的 setval（archivedHWM+1,
// is_called=false）留在序列上，再把 epoch 行抬到 max(archived, preRestore)+1，
// 但序列不动 → 后续 bumpEpoch nextval 从 archivedHWM+1 起步、低于已抬高的
// epoch 行 → epoch 倒退；hydrate 的 stale 守卫拒绝发布，writer 却返回成功
// → DB 新值/runtime 旧值永久分叉（Oracle scratch-PG 复现：归档 7 → 恢复前
// 37 → restore 后 39 → setConfig 返回 epoch 10，DB 333 / runtime 111）。
// 修复：restore 同步序列到新 epoch；bumpEpoch 自愈（greatest(nextval, epoch+1)
// + setval 回写）。以下用真实 archive→多次写→restore 旧 archive→set/clear/batch
// 验证 DB 值与 runtime 同步、epoch 严格单调。
// ──────────────────────────────────────────────────────────────────────────
describe('restore × write axis dedup — post-restore writes stay on the raised epoch (P1 round-2)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(async () => {
    resetTestConfig();
    replaceConfigSnapshot(EMPTY_SNAPSHOT);
    await resetDb();
  });

  it('archive → multiple writes → restore old archive → set/clear/batch keep epoch monotonic and runtime synced', async () => {
    const db = testDb();
    const epochs: number[] = [];

    // 1. archived state: value=111 at epoch e_a.
    await setConfig('AI_RATE_LIMIT_MAX', 111, { actor: 'cli' }, db);
    const zip = await zipBytes();

    // 2. multiple writes AFTER the archive — epoch axis climbs past e_a.
    const w1 = await setConfig('AI_RATE_LIMIT_MAX', 222, { actor: 'cli' }, db);
    const w2 = await setConfig('AI_RATE_LIMIT_MAX', 333, { actor: 'cli' }, db);
    const w3 = await clearConfig('AI_RATE_LIMIT_MAX', { actor: 'cli' }, db);
    const w4 = await setConfigs(
      [
        { key: 'AI_RATE_LIMIT_MAX', value: 444 },
        { key: 'KC_DEDUP_MAX_PAIRS', value: 9 },
      ],
      { actor: 'cli' },
      db,
    );
    epochs.push(w1.epoch, w2.epoch, w3.epoch, w4[0].epoch);
    for (let i = 1; i < epochs.length; i++) {
      expect(
        epochs[i],
        `pre-restore epochs must strictly increase (${epochs.join(',')})`,
      ).toBeGreaterThan(epochs[i - 1]);
    }

    // 3. restore the OLD archive (value=111, archived epoch ≪ current).
    const res = await restoreFromArchive({ db, r2: memR2(), bytes: zip });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const restoredEpoch = getConfigSnapshotEpoch();
    expect(restoredEpoch).toBeGreaterThan(epochs[epochs.length - 1]);
    expect(getConfig('AI_RATE_LIMIT_MAX', {})).toBe(111);

    // 4. setConfig after restore: epoch must stay ABOVE the raised epoch and the
    //    runtime must see the new value (pre-fix: returns archivedHWM+2 ≪
    //    restoredEpoch, stale guard refuses publish, runtime stays 111).
    const s1 = await setConfig('AI_RATE_LIMIT_MAX', 555, { actor: 'cli' }, db);
    expect(s1.epoch, 'post-restore write epoch must exceed the restored epoch').toBeGreaterThan(
      restoredEpoch,
    );
    expect(getConfig('AI_RATE_LIMIT_MAX', {}), 'runtime must sync with the DB row').toBe(555);
    const rows1 = (await db.select().from(system_config)) as Array<{ key: string; value: unknown }>;
    expect(rows1.find((r) => r.key === 'AI_RATE_LIMIT_MAX')?.value).toBe(555);
    const rep1 = await hydrateConfigFromDb(db);
    expect(rep1.staleSkipped ?? false, 'manual hydrate must not be guard-refused').toBe(false);
    epochs.push(s1.epoch);

    // 5. clear after restore: same axis discipline.
    const c1 = await clearConfig('AI_RATE_LIMIT_MAX', { actor: 'cli' }, db);
    expect(c1.epoch).toBeGreaterThan(s1.epoch);
    expect(getConfig('AI_RATE_LIMIT_MAX', {})).toBe(30); // code default
    epochs.push(c1.epoch);

    // 6. batch after restore: same axis discipline, both keys synced.
    const b1 = await setConfigs(
      [
        { key: 'AI_RATE_LIMIT_MAX', value: 666 },
        { key: 'KC_DEDUP_MAX_PAIRS', value: 11 },
      ],
      { actor: 'cli' },
      db,
    );
    expect(b1[0].epoch).toBeGreaterThan(c1.epoch);
    expect(getConfig('AI_RATE_LIMIT_MAX', {})).toBe(666);
    expect(getConfig('KC_DEDUP_MAX_PAIRS', {})).toBe(11);
    epochs.push(b1[0].epoch);

    // 7. global monotonicity across restore boundary.
    for (let i = 1; i < epochs.length; i++) {
      expect(
        epochs[i],
        `full epoch axis must strictly increase (${epochs.join(',')})`,
      ).toBeGreaterThan(epochs[i - 1]);
    }

    // Durable axis: the epoch row itself never regressed.
    const [epochRow] = await db.select().from(system_config_epoch);
    expect(Number(epochRow?.epoch)).toBe(epochs[epochs.length - 1]);
  });

  it('concurrent writers during/after restore cannot regress the epoch row (self-healing bump)', async () => {
    const db = testDb();
    await setConfig('AI_RATE_LIMIT_MAX', 111, { actor: 'cli' }, db);
    const zip = await zipBytes();
    await setConfig('AI_RATE_LIMIT_MAX', 222, { actor: 'cli' }, db);
    await setConfig('AI_RATE_LIMIT_MAX', 333, { actor: 'cli' }, db);

    const res = await restoreFromArchive({ db, r2: memR2(), bytes: zip });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const restoredEpoch = getConfigSnapshotEpoch();

    // 8-way parallel writes right after restore: every returned epoch must be >
    // restoredEpoch and the set must be strictly increasing (row-lock serializes;
    // pre-fix the first nextval lands at archivedHWM+2 ≪ restoredEpoch).
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        setConfig('AI_RATE_LIMIT_MAX', 700 + i, { actor: 'cli' }, db),
      ),
    );
    for (const r of results) {
      expect(r.epoch).toBeGreaterThan(restoredEpoch);
    }
    const revs = results.map((r) => r.epoch).sort((a, b) => a - b);
    for (let i = 1; i < revs.length; i++) {
      expect(revs[i]).toBeGreaterThan(revs[i - 1]);
    }
    // Runtime converged to one of the written values and a further hydrate is clean.
    const v = getConfig('AI_RATE_LIMIT_MAX', {});
    expect([700, 701, 702, 703, 704, 705, 706, 707]).toContain(v);
    const rep = await hydrateConfigFromDb(db);
    expect(rep.staleSkipped ?? false).toBe(false);
  });
});

describe('failed restore (mid-flight) leaves the config write axis healthy (P1 round-2 rollback semantics)', () => {
  const COLLECTION = 'test_yuk1007_restore_fail_mem0';
  const DIMS = 1024;
  let prevCollectionEnv: string | undefined;

  beforeAll(() => {
    prevCollectionEnv = process.env.MEM0_PGVECTOR_COLLECTION;
    process.env.MEM0_PGVECTOR_COLLECTION = COLLECTION;
  });
  afterAll(() => {
    if (prevCollectionEnv === undefined) delete process.env.MEM0_PGVECTOR_COLLECTION;
    else process.env.MEM0_PGVECTOR_COLLECTION = prevCollectionEnv;
  });

  beforeEach(async () => {
    await resetDb();
    await createMem0Collection(testDb(), COLLECTION, DIMS);
  });
  afterEach(async () => {
    await testDb().execute(sql.raw(`DROP TABLE IF EXISTS "${COLLECTION}"`));
    resetTestConfig();
    replaceConfigSnapshot(EMPTY_SNAPSHOT);
    await resetDb();
  });

  it('a mid-flight restore failure (rows rolled back) still leaves writes monotonic and runtime-synced', async () => {
    const db = testDb();
    // Establish a write-axis position.
    const w0 = await setConfig('AI_RATE_LIMIT_MAX', 77, { actor: 'cli' }, db);

    // Archive with the mem0 collection present, then corrupt the vector so the
    // restore throws DEEP inside the tx (after every setval) → atomic rollback.
    const good = await zipBytes();
    const bad = corruptMem0Vector(good);
    const fail = await restoreFromArchive({ db, r2: memR2(), bytes: bad });
    expect(fail.status).toBe(500);
    expect((fail.body as { error: string }).error).toBe('restore_failed_mid_flight');

    // Rows rolled back: the pre-failure value is still live.
    expect(getConfig('AI_RATE_LIMIT_MAX', {})).toBe(77);

    // Sequences are NOT transactional — the failed restore may have advanced
    // config_change_seq (jump-forward only, safe). The next write must still be
    // monotonic, published, and runtime-synced.
    const w1 = await setConfig('AI_RATE_LIMIT_MAX', 88, { actor: 'cli' }, db);
    expect(w1.epoch).toBeGreaterThan(w0.epoch);
    expect(getConfig('AI_RATE_LIMIT_MAX', {})).toBe(88);
    const rep = await hydrateConfigFromDb(db);
    expect(rep.staleSkipped ?? false).toBe(false);
  });

  /** 与 mem0-collection-backup.db.test.ts 同款：破坏 vector 文本使 ::vector cast 在 tx 深处拋。 */
  function corruptMem0Vector(bytes: Uint8Array): Uint8Array {
    const entries = unzipSync(bytes);
    const data = JSON.parse(new TextDecoder().decode(entries['data.json'])) as Record<
      string,
      Array<Record<string, unknown>>
    >;
    data[COLLECTION] = [
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        vector: 'not-a-vector',
        payload: { data: 'x' },
      },
    ];
    const repacked: Record<string, Uint8Array> = {};
    for (const [name, content] of Object.entries(entries)) {
      repacked[name] =
        name === 'data.json' ? new TextEncoder().encode(JSON.stringify(data)) : content;
    }
    return zipSync(repacked);
  }
});
