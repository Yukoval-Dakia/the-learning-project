// Verifies that the full chain of drizzle migrations (0000 → 0005) applies cleanly
// to a fresh pgvector/Postgres 16 testcontainer AND produces the expected post-1c.1-Lane-A
// schema state. The global vitest setup uses `db:push --force` which bypasses
// migration files — this test is the only thing that exercises the migrate path.
//
// Spawns its own testcontainer (independent of the shared one in tests/global-setup.ts)
// so it can start from an empty DB. Adds ~30-60s to the test run; worth it because
// migration regressions are silent until prod.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Mirror tests/global-setup.ts docker socket auto-detection (OrbStack / Docker Desktop)
function ensureDockerHost() {
  if (process.env.DOCKER_HOST) return;
  const orbstack = join(homedir(), '.orbstack/run/docker.sock');
  if (existsSync(orbstack)) {
    process.env.DOCKER_HOST = `unix://${orbstack}`;
    return;
  }
  const dockerDesktop = join(homedir(), '.docker/run/docker.sock');
  if (existsSync(dockerDesktop)) {
    process.env.DOCKER_HOST = `unix://${dockerDesktop}`;
  }
}

describe('migration smoke — drizzle migrate from empty DB', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    ensureDockerHost();
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    client = postgres(container.getConnectionUri(), { max: 1 });
    db = drizzle(client);

    // Apply all migrations from ./drizzle in journal order
    await migrate(db, { migrationsFolder: './drizzle' });
  }, 90_000); // 90s — container cold start + 6 migrations

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('creates Phase 1c.1 Lane A new tables (event, learning_session, material_fsrs_state, knowledge_edge)', async () => {
    const rows = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    const names = new Set(rows.map((r) => r.table_name));
    expect(names.has('event')).toBe(true);
    expect(names.has('learning_session')).toBe(true);
    expect(names.has('material_fsrs_state')).toBe(true);
    expect(names.has('knowledge_edge')).toBe(true);
  });

  it('DROPped legacy judgment + user_appeal tables (data-assumptions §O2)', async () => {
    const rows = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('judgment', 'user_appeal')
    `);
    expect(rows.length).toBe(0);
  });

  it('DROPped 3 mastery stub columns from knowledge (ADR-0012)', async () => {
    const rows = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'knowledge'
        AND column_name IN ('base_mastery', 'ai_delta_mastery', 'last_active_at')
    `);
    expect(rows.length).toBe(0);
  });

  it('preserves artifact table (activated per ADR-0006 v2, C-tier AI output landing)', async () => {
    const rows = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'artifact'
    `);
    expect(rows.length).toBe(1);
  });

  it('migrates artifact to ADR-0020 body_blocks shape and creates block-ref indexes', async () => {
    const columns = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'artifact'
    `);
    const names = new Set(columns.map((r) => r.column_name));
    expect(names.has('body_blocks')).toBe(true);
    expect(names.has('knowledge_ids')).toBe(true);
    expect(names.has('attrs')).toBe(true);
    expect(names.has('sections')).toBe(false);
    expect(names.has('outline_json')).toBe(false);
    expect(names.has('child_artifact_ids')).toBe(false);
    expect(names.has('knowledge_id')).toBe(false);

    // YUK-95 P5 (0020) — ref_kind discriminator on artifact_block_ref.
    const blockRefColumns = await db.execute<{
      column_name: string;
      column_default: string | null;
    }>(
      sql`
        SELECT column_name, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'artifact_block_ref'
      `,
    );
    const refKindCol = blockRefColumns.find((r) => r.column_name === 'ref_kind');
    expect(refKindCol).toBeDefined();
    expect(refKindCol?.column_default).toMatch(/cross_link/);

    const indexes = await db.execute<{ indexname: string; indexdef: string }>(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN ('artifact', 'artifact_block_ref', 'event')
        AND indexname IN (
          'artifact_knowledge_ids_gin_idx',
          'artifact_block_ref_to_idx',
          'artifact_block_ref_unique',
          'event_referenced_knowledge_gin'
        )
    `);
    const byName = new Map(indexes.map((r) => [r.indexname, r.indexdef]));
    expect(byName.get('artifact_knowledge_ids_gin_idx')).toMatch(/USING gin/i);
    expect(byName.get('artifact_knowledge_ids_gin_idx')).toMatch(/jsonb_path_ops/i);
    expect(byName.get('artifact_block_ref_to_idx')).toMatch(/to_artifact_id/i);
    expect(byName.get('artifact_block_ref_unique')).toMatch(/COALESCE/i);
    expect(byName.get('event_referenced_knowledge_gin')).toMatch(/USING gin/i);
  });

  it('creates knowledge_mastery view and view is queryable', async () => {
    const views = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.views
      WHERE table_schema = 'public' AND table_name = 'knowledge_mastery'
    `);
    expect(views.length).toBe(1);

    // Empty result is fine — just verify the view definition is valid (no SQL syntax bugs)
    const sample = await db.execute(sql`SELECT * FROM knowledge_mastery LIMIT 1`);
    expect(Array.isArray(sample)).toBe(true);
  });

  it('creates GIN index on event.payload with jsonb_path_ops opclass', async () => {
    const rows = await db.execute<{ indexname: string; indexdef: string }>(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'event'
    `);
    const gin = rows.find((r) => /USING gin/i.test(r.indexdef));
    expect(gin).toBeDefined();
    expect(gin?.indexdef).toMatch(/jsonb_path_ops/i);
  });

  it('installs pgvector extension for Mem0 pgvector backend', async () => {
    const rows = await db.execute<{ extname: string }>(sql`
      SELECT extname FROM pg_extension WHERE extname = 'vector'
    `);
    expect(rows.length).toBe(1);
  });

  it('event table has all expected columns including affected_scopes', async () => {
    const rows = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'event'
      ORDER BY ordinal_position
    `);
    const names = rows.map((r) => r.column_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'session_id',
        'actor_kind',
        'actor_ref',
        'action',
        'subject_kind',
        'subject_id',
        'outcome',
        'payload',
        'caused_by_event_id',
        'affected_scopes',
        'task_run_id',
        'cost_micro_usd',
        'created_at',
      ]),
    );
  });

  it('creates GIN index on event.affected_scopes', async () => {
    const rows = await db.execute<{ indexname: string; indexdef: string }>(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'event' AND indexname = 'event_affected_scopes_idx'
    `);
    expect(rows[0]?.indexdef).toMatch(/USING gin/i);
    expect(rows[0]?.indexdef).toMatch(/affected_scopes/i);
  });

  it('adds P5.3 long_term_freshness_score real column on memory_brief_note (YUK-183)', async () => {
    const rows = await db.execute<{ column_name: string; data_type: string }>(sql`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'memory_brief_note'
        AND column_name = 'long_term_freshness_score'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0]?.data_type).toBe('real');
  });

  it('U5 (0028) — answer revived with paper link columns + submitted_at nullable', async () => {
    const cols = await db.execute<{ column_name: string; is_nullable: string }>(sql`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'answer'
    `);
    const byName = new Map(cols.map((c) => [c.column_name, c.is_nullable]));
    for (const c of ['session_id', 'paper_artifact_id', 'part_ref', 'event_id', 'autosaved_at']) {
      expect(byName.has(c)).toBe(true);
    }
    // submitted_at flipped from NOT NULL → nullable (null = live draft).
    expect(byName.get('submitted_at')).toBe('YES');
  });

  it('U5 (0028) — learning_session.artifact_id column added', async () => {
    const rows = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'learning_session' AND column_name = 'artifact_id'
    `);
    expect(rows.length).toBe(1);
  });

  it('U5 (0028) — answer_draft_slot_uk is a partial unique index with COALESCE expression', async () => {
    const rows = await db.execute<{ indexdef: string }>(sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'answer'
        AND indexname = 'answer_draft_slot_uk'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0]?.indexdef).toMatch(/UNIQUE/i);
    expect(rows[0]?.indexdef).toMatch(/COALESCE/i);
    expect(rows[0]?.indexdef).toMatch(/submitted_at IS NULL/i);
  });

  it('U5 (0028) — partial index constrains only live drafts; frozen rows are append-only', async () => {
    // One slot (sess1, q1, atomic part_ref=NULL). Two FROZEN rows coexist
    // (append-only history after abandon→reopen→re-submit), then ONE live draft
    // is allowed, but a SECOND live draft on the same slot is rejected.
    const ins = (id: string, submitted: string | null) =>
      db.execute(sql`
      INSERT INTO answer (id, question_id, input_kind, content_md, image_refs, tags,
        submitted_at, session_id, part_ref, autosaved_at)
      VALUES (${id}, 'q1', 'text', '', '[]'::jsonb, '[]'::jsonb,
        ${submitted ? sql`${submitted}::timestamptz` : sql`NULL`}, 'sess1', NULL, now())
    `);

    await ins('a_frozen_1', '2026-06-05T00:00:00Z');
    await ins('a_frozen_2', '2026-06-05T01:00:00Z');
    // Two frozen rows for the same slot coexist (partial index excludes them).
    await ins('a_live_1', null);
    // A second live draft on the same slot must collide on answer_draft_slot_uk.
    await expect(ins('a_live_2', null)).rejects.toMatchObject({ cause: { code: '23505' } });

    // Cleanup so the assertion doesn't leak into other smoke assertions.
    await db.execute(sql`DELETE FROM answer WHERE session_id = 'sess1'`);
  });

  it('creates memory_reconciliation_log table (YUK-342 P2)', async () => {
    const rows = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'memory_reconciliation_log'
    `);
    expect(rows.length).toBe(1);

    const cols = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'memory_reconciliation_log'
    `);
    const names = new Set(cols.map((r) => r.column_name));
    for (const expected of [
      'id',
      'user_id',
      'new_memory_id',
      'old_memory_id',
      'action',
      'reason',
      'llm_raw',
      'planned_at',
      'applied_at',
    ]) {
      expect(names.has(expected)).toBe(true);
    }

    const indexes = await db.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'memory_reconciliation_log'
    `);
    const idxNames = new Set(indexes.map((r) => r.indexname));
    expect(idxNames.has('memory_recon_user_idx')).toBe(true);
    expect(idxNames.has('memory_recon_unapplied_idx')).toBe(true);
  });

  it('knowledge_edge has FK to knowledge on both from and to', async () => {
    const rows = await db.execute<{ column_name: string; foreign_table_name: string }>(sql`
      SELECT
        kcu.column_name,
        ccu.table_name AS foreign_table_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.table_schema = 'public'
        AND tc.table_name = 'knowledge_edge'
        AND tc.constraint_type = 'FOREIGN KEY'
    `);
    const fks = rows.filter((r) => r.foreign_table_name === 'knowledge').map((r) => r.column_name);
    expect(fks).toEqual(expect.arrayContaining(['from_knowledge_id', 'to_knowledge_id']));
  });
});
