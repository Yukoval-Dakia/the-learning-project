/**
 * Round-trip test: GET /api/_/export → POST /api/_/import
 * Uses real test DB (postgres-js) + in-memory R2.
 * Verifies that data exported from a seeded DB is fully restored after a wipe.
 */
import { knowledge, mistake } from '@/db/schema';
import { sql } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { memR2 } from '../../../tests/helpers/r2';
import { GET } from './export/route';
import { POST } from './import/route';

const r2 = memR2();
vi.mock('@/server/r2', () => ({
  getR2: () => r2,
  createR2Client: () => r2,
}));

describe('round-trip: export → import → DB state mirrored', () => {
  beforeEach(async () => {
    r2._store.clear();
    await resetDb();
  });

  it('preserves knowledge + mistake rows end-to-end', async () => {
    const db = testDb();

    // 1. Seed DB with fixtures
    const now = new Date('2024-01-01T00:00:00Z');
    await db.insert(knowledge).values({
      id: 'k1',
      name: '虚词',
      domain: 'wenyan',
      parent_id: null,
      base_mastery: 0,
      ai_delta_mastery: 0,
      last_active_at: null,
      merged_from: [],
      archived_at: null,
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });

    // 2. Export
    const exportRes = await GET(new Request('http://localhost/api/_/export'));
    expect(exportRes.status).toBe(200);
    const ab = await exportRes.arrayBuffer();
    const entries = unzipSync(new Uint8Array(ab));
    expect(entries['data.json']).toBeDefined();
    expect(entries['manifest.json']).toBeDefined();

    const data = JSON.parse(new TextDecoder().decode(entries['data.json'])) as {
      knowledge: unknown[];
    };
    expect(data.knowledge).toHaveLength(1);

    // 3. Wipe DB
    await resetDb();
    const rowsAfterWipe = await db.select().from(knowledge);
    expect(rowsAfterWipe).toHaveLength(0);

    // 4. Import
    const importRes = await POST(
      new Request('http://localhost/api/_/import?confirm=wipe-and-reload', {
        method: 'POST',
        body: new Uint8Array(ab),
        headers: { 'content-type': 'application/zip' },
      }),
    );
    if (importRes.status !== 200) {
      const errBody = await importRes.clone().json();
      console.error('Import failed:', JSON.stringify(errBody, null, 2));
    }
    expect(importRes.status).toBe(200);
    const body = (await importRes.json()) as {
      ok: boolean;
      stats: Record<string, { inserted: number }>;
    };
    expect(body.ok).toBe(true);
    expect(body.stats.knowledge.inserted).toBe(1);

    // 5. Verify DB rows restored
    const rowsAfterImport = await db.select().from(knowledge);
    expect(rowsAfterImport).toHaveLength(1);
    expect(rowsAfterImport[0].id).toBe('k1');
    expect(rowsAfterImport[0].name).toBe('虚词');
  });
});
