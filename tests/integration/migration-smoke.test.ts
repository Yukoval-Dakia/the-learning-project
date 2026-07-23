// Verifies that the full chain of drizzle migrations (0000 → 0005) applies cleanly
// to a fresh pgvector/Postgres 16 testcontainer AND produces the expected post-1c.1-Lane-A
// schema state. The global vitest setup uses `db:push --force` which bypasses
// migration files — this test is the only thing that exercises the migrate path.
//
// Spawns its own testcontainer (independent of the shared one in tests/global-setup.ts)
// so it can start from an empty DB. Adds ~30-60s to the test run; worth it because
// migration regressions are silent until prod.

import { existsSync, readFileSync } from 'node:fs';
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

  it('YUK-609 data migration normalizes only index-matching quiz_gen labels and is idempotent', async () => {
    const quizGenId = 'migration:yuk609:quiz-gen';
    const mismatchId = 'migration:yuk609:mismatch';
    const manualId = 'migration:yuk609:manual';
    const now = '2026-07-18T00:00:00Z';
    try {
      await db.execute(sql`
        INSERT INTO question (
          id, kind, prompt_md, choices_md, knowledge_ids, difficulty, source,
          embed_content_hash, created_at, updated_at, version
        ) VALUES
          (
            ${quizGenId}, 'choice', '迁移测试',
            '["A. 举例论证", "Ｂ． 对比论证", "C、比喻论证", "D) 道理论证"]'::jsonb,
            '[]'::jsonb, 2, 'quiz_gen', 'stale-hash', ${now}::timestamptz,
            ${now}::timestamptz, 7
          ),
          (
            ${mismatchId}, 'choice', '错位标签对照',
            '["A. 保持整组", "C. 错位标签"]'::jsonb,
            '[]'::jsonb, 2, 'quiz_gen', 'mismatch-hash', ${now}::timestamptz,
            ${now}::timestamptz, 6
          ),
          (
            ${manualId}, 'choice', '非 quiz_gen 对照',
            '["A. 保持原样", "B. 保持原样"]'::jsonb,
            '[]'::jsonb, 2, 'manual', 'manual-hash', ${now}::timestamptz,
            ${now}::timestamptz, 5
          )
      `);

      const migrationSql = readFileSync(
        join(process.cwd(), 'drizzle/0066_yuk609_normalize_quiz_gen_choices.sql'),
        'utf8',
      );
      await client.unsafe(migrationSql);
      // Re-running must be a no-op: version only bumps for an actual choices_md change.
      await client.unsafe(migrationSql);

      const rows = await db.execute<{
        id: string;
        choices_md: string[];
        embed_content_hash: string | null;
        version: number;
      }>(sql`
        SELECT id, choices_md, embed_content_hash, version
        FROM question
        WHERE id IN (${quizGenId}, ${mismatchId}, ${manualId})
        ORDER BY id
      `);
      const byId = new Map(rows.map((row) => [row.id, row]));

      expect(byId.get(quizGenId)).toMatchObject({
        choices_md: ['举例论证', '对比论证', '比喻论证', '道理论证'],
        embed_content_hash: null,
        version: 8,
      });
      expect(byId.get(mismatchId)).toMatchObject({
        choices_md: ['A. 保持整组', 'C. 错位标签'],
        embed_content_hash: 'mismatch-hash',
        version: 6,
      });
      expect(byId.get(manualId)).toMatchObject({
        choices_md: ['A. 保持原样', 'B. 保持原样'],
        embed_content_hash: 'manual-hash',
        version: 5,
      });
    } finally {
      await db.execute(
        sql`DELETE FROM question WHERE id IN (${quizGenId}, ${mismatchId}, ${manualId})`,
      );
    }
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

  it('adds question_block.ordinal (NOT NULL default 0) + session index (0068, YUK-221)', async () => {
    const cols = await db.execute<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(sql`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'question_block'
        AND column_name = 'ordinal'
    `);
    expect(cols.length).toBe(1);
    expect(cols[0]?.data_type).toBe('integer');
    expect(cols[0]?.is_nullable).toBe('NO');

    const idx = await db.execute<{ indexdef: string }>(sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'question_block'
        AND indexname = 'question_block_session_ordinal_idx'
    `);
    expect(idx[0]?.indexdef).toMatch(/ingestion_session_id/i);
    expect(idx[0]?.indexdef).toMatch(/ordinal/i);
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

  it('creates B1-W1 diagnostic tables (mastery_state, item_calibration) with expected columns (ADR-0035)', async () => {
    const rows = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name IN ('mastery_state', 'item_calibration')
    `);
    const names = new Set(rows.map((r) => r.table_name));
    expect(names.has('mastery_state')).toBe(true);
    expect(names.has('item_calibration')).toBe(true);

    const masteryCols = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'mastery_state'
    `);
    const masteryNames = new Set(masteryCols.map((r) => r.column_name));
    for (const expected of [
      'id',
      'subject_kind',
      'subject_id',
      'theta_hat',
      'evidence_count',
      'success_count',
      'fail_count',
      'last_outcome_at',
      'calibration_residual',
      'fluency_illusion_flag',
      // YUK-361 Phase 2 — Urnings-Lite θ 不确定性持久化列。
      'theta_precision',
      'last_theta_delta',
    ]) {
      expect(masteryNames.has(expected)).toBe(true);
    }

    const calCols = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'item_calibration'
    `);
    const calNames = new Set(calCols.map((r) => r.column_name));
    for (const expected of [
      'id',
      'question_id',
      'b',
      'confidence',
      'track',
      'source',
      'irt_a',
      'irt_c',
      'cdm_json',
      'kt_json',
    ]) {
      expect(calNames.has(expected)).toBe(true);
    }
  });

  it('YUK-495 S4 (0051) — mastery_state.theta_hat/theta_precision widened to double precision', async () => {
    const rows = await db.execute<{ column_name: string; data_type: string }>(sql`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'mastery_state'
        AND column_name IN ('theta_hat', 'theta_precision')
      ORDER BY column_name
    `);
    const byCol = Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
    // decision-④: f64 live column matches the JSONB f64 state_snapshot → Tier-2 bit-exact replay.
    expect(byCol.theta_hat).toBe('double precision');
    expect(byCol.theta_precision).toBe('double precision');
  });

  it('creates YUK-361 Phase 1 selection_observation table + practice_stream_item.signals (0035)', async () => {
    // 表存在 + 期望列齐全。
    const tableRows = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name = 'selection_observation'
    `);
    expect(new Set(tableRows.map((r) => r.table_name)).has('selection_observation')).toBe(true);

    const obsCols = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'selection_observation'
    `);
    const obsNames = new Set(obsCols.map((r) => r.column_name));
    for (const expected of [
      'id',
      'date',
      'stream_item_id',
      'ref_kind',
      'ref_id',
      'policy',
      'selected',
      'inclusion_probability',
      'signals',
      'created_at',
    ]) {
      expect(obsNames.has(expected)).toBe(true);
    }

    const obsIdx = await db.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'selection_observation'
    `);
    const obsIdxNames = new Set(obsIdx.map((r) => r.indexname));
    expect(obsIdxNames.has('selection_observation_date_ref_idx')).toBe(true);
    expect(obsIdxNames.has('selection_observation_date_idx')).toBe(true);

    // practice_stream_item.signals 列存在（Task 6 零行为变更附加列）。
    const streamCols = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'practice_stream_item'
        AND column_name = 'signals'
    `);
    expect(streamCols).toHaveLength(1);
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

  it('YUK-531 PR-3 (0057) — misconception_reconciliation_log table with expected columns + indexes', async () => {
    const tableRows = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'misconception_reconciliation_log'
    `);
    expect(tableRows.length).toBe(1);

    const cols = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'misconception_reconciliation_log'
    `);
    const names = new Set(cols.map((r) => r.column_name));
    for (const expected of [
      'id',
      'candidate_from_kind',
      'candidate_from_id',
      'candidate_to_kind',
      'candidate_to_id',
      'candidate_relation_type',
      'action',
      'superseded_edge_id',
      'confidence',
      'reason',
      'llm_raw',
      'planned_at',
      'applied_at',
    ]) {
      expect(names.has(expected)).toBe(true);
    }

    const indexes = await db.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'misconception_reconciliation_log'
    `);
    const idxNames = new Set(indexes.map((r) => r.indexname));
    expect(idxNames.has('misconception_recon_candidate_idx')).toBe(true);
    expect(idxNames.has('misconception_recon_unapplied_idx')).toBe(true);
  });

  it('YUK-531 PR-3 (0057) — misconception_edge weight CHECK rejects out-of-range, accepts 0-1', async () => {
    const ins = (id: string, weight: number) =>
      db.execute(sql`
        INSERT INTO misconception_edge
          (id, from_kind, from_id, to_kind, to_id, relation_type, weight, created_by,
           proposed_by_ai, created_at, updated_at)
        VALUES (${id}, 'misconception', 'misc_1', 'knowledge', 'kn_1', 'caused_by',
           ${weight}, '{"by":"ai"}'::jsonb, true, now(), now())
      `);

    // weight 1.5 violates misconception_edge_weight_range (PG check_violation 23514).
    await expect(ins('mce_bad', 1.5)).rejects.toMatchObject({ cause: { code: '23514' } });
    // A legitimate 0-1 weight inserts cleanly.
    await expect(ins('mce_ok', 0.5)).resolves.toBeDefined();

    // Cleanup so the row doesn't leak into other smoke assertions.
    await db.execute(sql`DELETE FROM misconception_edge WHERE id = 'mce_ok'`);
  });
});

// YUK-384 — durable hub-sync migration must backfill a reconciliation cursor for
// every live hub that already existed BEFORE the migration ran. This describe
// spins its own testcontainer and migrates ONLY through the frozen baseline
// (0070) so it can seed a pre-0071 live hub, then applies the pending migration
// (0071) and the forward trigger-function fix (0072), then asserts the exact
// schema/triggers/functions plus the live-hub backfill.
describe('migration smoke — YUK-384 durable hub sync backfill', () => {
  // Frozen baseline: the last migration on main before 0071. `beforeAll` stops
  // here so the old-schema fixture is seeded before the durable-cursor DDL runs.
  const BASELINE_TAG = '0070_yuk736_snapshot_baseline';

  let container: StartedPostgreSqlContainer;
  let oldSchemaSql: ReturnType<typeof postgres>;

  function orderedMigrations(): { tag: string; sql: string }[] {
    const journal = JSON.parse(
      readFileSync(join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string }[] };
    return [...journal.entries]
      .sort((a, b) => a.idx - b.idx)
      .map((entry) => ({
        tag: entry.tag,
        sql: readFileSync(join(process.cwd(), 'drizzle', `${entry.tag}.sql`), 'utf8'),
      }));
  }

  // Apply one migration file the way drizzle's migrator does: split on the
  // statement-breakpoint marker and run each top-level statement on its own
  // (plpgsql `$$` bodies never contain the marker, so they stay intact).
  async function applyMigrationFile(client: ReturnType<typeof postgres>, fileSql: string) {
    for (const chunk of fileSql.split('--> statement-breakpoint')) {
      const statement = chunk.trim();
      if (statement.length === 0) continue;
      await client.unsafe(statement);
    }
  }

  // Applies every migration AFTER the frozen baseline. During RED (before 0071
  // exists) this is a no-op, so the later `hub_sync_reconciliation` query fails
  // with "relation does not exist"; once 0071 lands it installs the durable
  // schema and backfills the already-seeded live hub.
  async function applyPendingMigrations(client: ReturnType<typeof postgres>) {
    let seenBaseline = false;
    for (const migration of orderedMigrations()) {
      if (seenBaseline) await applyMigrationFile(client, migration.sql);
      if (migration.tag === BASELINE_TAG) seenBaseline = true;
    }
  }

  beforeAll(async () => {
    ensureDockerHost();
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    oldSchemaSql = postgres(container.getConnectionUri(), { max: 1 });

    let reachedBaseline = false;
    for (const migration of orderedMigrations()) {
      await applyMigrationFile(oldSchemaSql, migration.sql);
      if (migration.tag === BASELINE_TAG) {
        reachedBaseline = true;
        break;
      }
    }
    if (!reachedBaseline) {
      throw new Error(`baseline migration ${BASELINE_TAG} not found in journal`);
    }
  }, 120_000);

  afterAll(async () => {
    await oldSchemaSql?.end();
    await container?.stop();
  });

  it('YUK-384 RED 01: installs exact durable hub-sync schema, triggers, indexes, and backfills live hubs', async () => {
    // Grounding (2026-07-21): `artifact.knowledge_ids` is jsonb (seed `'[]'::jsonb`,
    // never `text[]`), `body_blocks` is the ArtifactBodyBlocksT doc shape, and
    // `intent_source`/`source`/`created_at`/`updated_at` are NOT NULL without
    // defaults, so the fixture must supply them for the insert to reach the
    // durable-schema assertions below.
    await oldSchemaSql`
      insert into artifact (
        id, type, title, body_blocks, attrs, knowledge_ids,
        intent_source, source, created_at, updated_at, version
      )
      values (
        'hub-existing', 'note_hub', 'Hub', '{"type":"doc","content":[]}'::jsonb,
        '{}'::jsonb, '[]'::jsonb, 'system', 'system', now(), now(), 1
      )
    `;
    await applyPendingMigrations(oldSchemaSql);

    const rows = await oldSchemaSql<
      {
        artifact_id: string;
        generation: string;
        acknowledged_generation: string;
        status: string;
      }[]
    >`
      select artifact_id, generation::text, acknowledged_generation::text, status
      from hub_sync_reconciliation
    `;
    expect(rows).toEqual([
      {
        artifact_id: 'hub-existing',
        generation: '1',
        acknowledged_generation: '0',
        status: 'pending',
      },
    ]);

    const indexes = await oldSchemaSql<{ indexname: string }[]>`
      select indexname from pg_indexes
      where tablename in ('hub_sync_reconciliation', 'artifact_edit_session')
      order by indexname
    `;
    expect(indexes.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'hub_sync_reconciliation_pkey',
        'hub_sync_ready_idx',
        'hub_sync_expired_idx',
        'hub_sync_dirty_age_idx',
        'artifact_edit_session_pkey',
        'artifact_edit_session_recent_idx',
      ]),
    );

    const triggers = await oldSchemaSql<{ tgname: string }[]>`
      select tgname from pg_trigger
      where not tgisinternal and tgname like 'hub_sync_%'
      order by tgname
    `;
    expect(triggers.map((row) => row.tgname)).toEqual([
      'hub_sync_artifact_dirty',
      'hub_sync_knowledge_dirty',
      'hub_sync_knowledge_edge_dirty',
    ]);

    const triggerFunctions = await oldSchemaSql<{ proname: string; definition: string }[]>`
      select p.proname, pg_get_functiondef(p.oid) as definition
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('fanout_hub_sync_dirty', 'mark_hub_sync_dirty')
      order by p.proname
    `;
    expect(triggerFunctions.map((row) => row.proname)).toEqual([
      'fanout_hub_sync_dirty',
      'mark_hub_sync_dirty',
    ]);
    expect(triggerFunctions[0]?.definition).toContain('ORDER BY target_artifact_id');
    expect(triggerFunctions[0]?.definition).toContain('id <> NEW.id');
    expect(triggerFunctions[0]?.definition).not.toContain(
      "ELSIF OLD.type = 'note_atomic' OR NEW.type = 'note_atomic'",
    );

    const liveHubIndexes = await oldSchemaSql<
      {
        index_name: string;
        table_name: string;
        definition: string;
        predicate: string;
      }[]
    >`
      select
        index_class.relname as index_name,
        table_class.relname as table_name,
        pg_get_indexdef(pg_index.indexrelid) as definition,
        pg_get_expr(pg_index.indpred, pg_index.indrelid) as predicate
      from pg_index
      join pg_class index_class on index_class.oid = pg_index.indexrelid
      join pg_class table_class on table_class.oid = pg_index.indrelid
      join pg_namespace table_namespace on table_namespace.oid = table_class.relnamespace
      where table_namespace.nspname = 'public'
        and index_class.relname = 'artifact_live_note_hub_idx'
    `;

    expect(liveHubIndexes).toEqual([
      {
        index_name: 'artifact_live_note_hub_idx',
        table_name: 'artifact',
        definition:
          "CREATE INDEX artifact_live_note_hub_idx ON public.artifact USING btree (id) WHERE ((type = 'note_hub'::text) AND (archived_at IS NULL))",
        predicate: "((type = 'note_hub'::text) AND (archived_at IS NULL))",
      },
    ]);
  });
});

// YUK-751 — prove the locked 0076 upgrade path against an already-populated event log.
describe('migration smoke — YUK-751 populated event backfill', () => {
  const BASELINE_TAG = '0075_yuk452_placement_starter_integrity';
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;

  function orderedMigrations(): { tag: string; sql: string }[] {
    const journal = JSON.parse(
      readFileSync(join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string }[] };
    return [...journal.entries]
      .sort((a, b) => a.idx - b.idx)
      .map((entry) => ({
        tag: entry.tag,
        sql: readFileSync(join(process.cwd(), 'drizzle', `${entry.tag}.sql`), 'utf8'),
      }));
  }

  async function applyMigrationFile(fileSql: string) {
    for (const chunk of fileSql.split('--> statement-breakpoint')) {
      const statement = chunk.trim();
      if (statement.length > 0) await client.unsafe(statement);
    }
  }

  beforeAll(async () => {
    ensureDockerHost();
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    client = postgres(container.getConnectionUri(), { max: 1 });
    for (const migration of orderedMigrations()) {
      await applyMigrationFile(migration.sql);
      if (migration.tag === BASELINE_TAG) break;
    }
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('deterministically backfills every event and advances new inserts above the max', async () => {
    const insertEvent = async (id: string, createdAt: string) => {
      await client`insert into event
        (id, actor_kind, actor_ref, action, subject_kind, subject_id, payload, affected_scopes, created_at)
        values (${id}, 'system', 'migration-test', 'experimental:test', 'event', ${id},
          '{}'::jsonb, array[]::text[], ${createdAt}::timestamptz)`;
    };
    await insertEvent('event-z', '2020-01-01T00:00:00Z');
    await insertEvent('event-a', '2020-01-01T00:00:00Z');
    await insertEvent('event-later', '2021-01-01T00:00:00Z');

    const migration = orderedMigrations().find(
      (entry) => entry.tag === '0076_yuk751_event_subscriptions',
    );
    if (!migration) throw new Error('0076_yuk751_event_subscriptions missing from journal');
    await applyMigrationFile(migration.sql);

    const backfilled = await client<{ id: string; dispatch_seq: string }[]>`
      select id, dispatch_seq::text from event order by dispatch_seq
    `;
    expect(backfilled).toEqual([
      { id: 'event-a', dispatch_seq: '1' },
      { id: 'event-z', dispatch_seq: '2' },
      { id: 'event-later', dispatch_seq: '3' },
    ]);

    await insertEvent('event-new', '2019-01-01T00:00:00Z');
    const inserted = await client<{ dispatch_seq: string }[]>`
      select dispatch_seq::text from event where id = 'event-new'
    `;
    expect(inserted[0]?.dispatch_seq).toBe('4');
  });
});
