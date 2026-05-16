// Phase 1c.1 Step 8.C — smoke test for the test-side `runMigrationInTest`
// re-export. Full coverage of `runMigration` lives in
// `tests/integration/migrate-phase1c1.integration.test.ts` (50-row fixture);
// this is purely about the re-export wiring not silently rotting.
//
// Seeds the smallest meaningful legacy row (one ingestion_session, no other
// tables) and asserts the helper invocation produces the expected projection
// in `learning_session`. If the helper or the underlying script gets renamed
// or the export disappears, this test fails with a clear import-time error.

import { ingestion_session, learning_session } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../helpers/db';
import { runMigrationInTest } from '../helpers/migration';

describe('tests/helpers/migration — runMigrationInTest re-export', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('re-export invokes runMigration and projects ingestion_session → learning_session', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(ingestion_session).values({
      id: 'is_helper_smoke',
      source_document_id: null,
      source_asset_ids: ['a_helper'],
      status: 'uploaded',
      entrypoint: 'vision_single',
      warnings: [],
      error_message: null,
      created_at: now,
      updated_at: now,
      version: 1,
    });

    const result = await runMigrationInTest(db);
    expect(result.ok).toBe(true);

    const sessions = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, 'is_helper_smoke'));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.type).toBe('ingestion');
    expect(sessions[0]?.status).toBe('uploaded');
  });
});
