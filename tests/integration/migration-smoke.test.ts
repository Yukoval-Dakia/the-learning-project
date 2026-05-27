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

    const indexes = await db.execute<{ indexname: string; indexdef: string }>(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN ('artifact_block_ref', 'event')
        AND indexname IN (
          'artifact_block_ref_to_idx',
          'artifact_block_ref_unique',
          'event_referenced_knowledge_gin'
        )
    `);
    const byName = new Map(indexes.map((r) => [r.indexname, r.indexdef]));
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
