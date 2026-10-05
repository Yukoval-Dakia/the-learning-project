// YUK-986 (Supply-Agent/1) — jyeoo staged-asset reaper db 测试。
// 回收 fetch 阶段产生但从未被 commit 引用的孤儿资产（24h 宽限）；
// R2 对象只在最后一个 owner 消失时删除（镜像 cleanupQuestionAssets 语义）。

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { question, source_asset } from '@/db/schema';
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

async function seedQuestionWithImageRef(id: string, assetId: string): Promise<void> {
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: '图题',
    reference_md: '答案',
    knowledge_ids: [],
    difficulty: 3,
    source: 'jyeoo',
    metadata: null as never,
    draft_status: null,
    variant_depth: 0,
    image_refs: [assetId],
    created_at: NOW,
    updated_at: NOW,
    version: 0,
  });
}

describe('runJyeooStagedAssetReap', () => {
  it('deletes old unreferenced staged assets (row + R2 object)', async () => {
    const r2 = memR2();
    await seedAsset('asset-orphan');
    r2._store.set('ingestion/test/asset-orphan.jpg', Buffer.from('x'));

    const result = await runJyeooStagedAssetReap(db, { r2, now: NOW });
    expect(result.reapedRows).toBe(1);
    expect(result.reapedObjects).toBe(1);
    expect(await db.select().from(source_asset)).toHaveLength(0);
    expect(r2._store.size).toBe(0);
  });

  it('keeps staged assets referenced by a question (committed candidates)', async () => {
    const r2 = memR2();
    await seedAsset('asset-committed');
    r2._store.set('ingestion/test/asset-committed.jpg', Buffer.from('x'));
    await seedQuestionWithImageRef('q-with-ref', 'asset-committed');

    const result = await runJyeooStagedAssetReap(db, { r2, now: NOW });
    expect(result.reapedRows).toBe(0);
    expect(result.keptReferenced).toBe(1);
    expect(await db.select().from(source_asset)).toHaveLength(1);
    expect(r2._store.size).toBe(1);
  });

  it('keeps young staged assets inside the grace window', async () => {
    const r2 = memR2();
    await seedAsset('asset-young', { createdAt: YOUNG });
    r2._store.set('ingestion/test/asset-young.jpg', Buffer.from('x'));

    const result = await runJyeooStagedAssetReap(db, { r2, now: NOW });
    expect(result.reapedRows).toBe(0);
    expect(await db.select().from(source_asset)).toHaveLength(1);
  });

  it('never touches non-staged assets even when old and unreferenced', async () => {
    const r2 = memR2();
    await seedAsset('asset-ingested', { origin: 'ingestion_upload' });
    r2._store.set('ingestion/test/asset-ingested.jpg', Buffer.from('x'));

    const result = await runJyeooStagedAssetReap(db, { r2, now: NOW });
    expect(result.reapedRows).toBe(0);
    expect(await db.select().from(source_asset)).toHaveLength(1);
  });

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
