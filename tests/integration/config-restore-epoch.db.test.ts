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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type ConfigSnapshot,
  getConfig,
  getConfigSnapshotEpoch,
  replaceConfigSnapshot,
  resetTestConfig,
} from '@/core/config/store';
import { system_config_epoch } from '@/db/schema';
import { hydrateConfigFromDb } from '@/server/config/hydrate';
import { setConfig } from '@/server/config/write';
import { buildBackupArchive, restoreFromArchive } from '@/server/export/archive';
import { resetDb, testDb } from '../helpers/db';
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
