// Phase 1c.1 Step 8.A — assert the shared testcontainer has the full migration
// set applied (not just the schema-pushed shape).
//
// This is the regression guard for the global-setup switch from
// `db:push --force` → `drizzle-kit migrate`. If a future change reverts to
// `db:push` (which skips hand-written `.sql` files), this test fails fast with
// a clear signal:
//
//   - `knowledge_mastery` view exists (declared in
//      drizzle/0005_phase1c1_event_payload_gin_and_mastery_view.sql)
//   - GIN index `event_payload_idx` on `event.payload` with jsonb_path_ops exists
//
// `tests/integration/migration-smoke.test.ts` exercises the same artefacts but
// spins up its OWN container to test the migration end-to-end from empty. This
// test asserts the SHARED container (used by every other test file) has them
// too — distinct concern, distinct test.

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { testDb } from '../helpers/db';

describe('shared testcontainer — Phase 1c.1 Step 8 migrations applied', () => {
  it('creates knowledge_mastery view in the shared global-setup container', async () => {
    const db = testDb();
    const rows = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.views
      WHERE table_schema = 'public' AND table_name = 'knowledge_mastery'
    `);
    expect(rows.length).toBe(1);
  });

  it('knowledge_mastery view is queryable (no SQL syntax bugs)', async () => {
    const db = testDb();
    // Empty result is fine — we just need the view definition valid.
    const sample = await db.execute(sql`SELECT * FROM knowledge_mastery LIMIT 1`);
    expect(Array.isArray(sample)).toBe(true);
  });

  it('creates GIN index event_payload_idx with jsonb_path_ops opclass', async () => {
    const db = testDb();
    const rows = await db.execute<{ indexname: string; indexdef: string }>(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'event'
    `);
    const gin = rows.find((r) => /USING gin/i.test(r.indexdef));
    expect(gin).toBeDefined();
    expect(gin?.indexdef).toMatch(/jsonb_path_ops/i);
  });
});
