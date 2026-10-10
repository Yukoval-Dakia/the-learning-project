// YUK-986 (Supply-Agent/1) — jyeoo staged-asset reaper db 测试。
// 回收 fetch 阶段产生但从未被 commit 引用的孤儿资产（24h 宽限）；
// R2 对象只在最后一个 owner 消失时删除（镜像 cleanupQuestionAssets 语义）。

import { beforeEach, describe, expect, it } from 'vitest';
import { source_asset } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { memR2 } from '../../../../tests/helpers/r2';
import { runJyeooStagedAssetReap } from './jyeoo_staged_asset_reap';

const db = testDb();

beforeEach(() => resetDb());

const NOW = new Date('2026-09-11T12:00:00Z');
const OLD = new Date('2026-09-09T12:00:00Z'); // >24h before NOW
const YOUNG = new Date('2026-09-11T06:00:00Z'); // <24h before NOW

async function seedAsset(
  id: string,
  opts: { origin?: string; createdAt?: Date; storageKey?: string } = {},
): Promise<void> {
  await db.insert(source_asset).values({
    id,
    kind: 'image',
    storage_key: opts.storageKey ?? `ingestion/test/${id}.jpg`,
    mime_type: 'image/jpeg',
    byte_size: 128,
    sha256: id.padEnd(64, '0'),
    provenance: { origin: opts.origin ?? 'jyeoo_staged' },
    created_at: opts.createdAt ?? OLD,
  });
}

describe('runJyeooStagedAssetReap', () => {
  it('keeps the R2 object while another owner row still points at the same storage_key', async () => {
    const r2 = memR2();
    const sharedKey = 'ingestion/test/shared.jpg';
    await seedAsset('asset-a', { storageKey: sharedKey });
    await seedAsset('asset-b', { origin: 'ingestion_upload', storageKey: sharedKey });
    r2._store.set(sharedKey, Buffer.from('x'));

    const result = await runJyeooStagedAssetReap(db, { r2, now: NOW });
    expect(result.reapedRows).toBe(1); // only the staged orphan row
    expect(result.reapedObjects).toBe(0); // shared storage_key 仍有 owner
    const remaining = await db.select().from(source_asset);
    expect(remaining.map((row) => row.id)).toEqual(['asset-b']);
    expect(r2._store.has(sharedKey)).toBe(true); // object survives for the remaining owner
  });
});
