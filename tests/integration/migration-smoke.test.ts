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
import { InterventionSettlement } from '@/core/schema/intervention';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type JSONValue } from 'postgres';
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
// statement-breakpoint marker while leaving plpgsql bodies intact.
async function applyMigrationFile(client: ReturnType<typeof postgres>, fileSql: string) {
  for (const chunk of fileSql.split('--> statement-breakpoint')) {
    const statement = chunk.trim();
    if (statement.length === 0) continue;
    await client.unsafe(statement);
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

// YUK-821 — prove the v3 accept gate does not strand already-pending v1/v2
// Teaching Briefs during upgrade. The migration must retire only incomplete
// pending conjectures, preserve complete v3/decided rows, and stay idempotent.
describe('migration smoke — YUK-821 legacy conjecture retirement', () => {
  const BASELINE_TAG = '0081_illegal_queen_noir';
  const MIGRATION_TAG = '0082_yuk821_retire_legacy_pending_conjectures';
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
    let reachedBaseline = false;
    for (const migration of orderedMigrations()) {
      await applyMigrationFile(migration.sql);
      if (migration.tag === BASELINE_TAG) {
        reachedBaseline = true;
        break;
      }
    }
    if (!reachedBaseline) throw new Error(`baseline migration ${BASELINE_TAG} not found`);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('retracts only incomplete pending rows without minting an owner dismissal', async () => {
    const v3Change = {
      probe_md: 'primary',
      probe_reference_md: 'primary reference',
      followup_probe_md: 'follow-up',
      followup_probe_reference_md: 'follow-up reference',
      diagnostic_spec: { schema_version: 1 },
      probe_spec: { prompt_md: 'primary', reference_md: 'primary reference' },
      followup_probe_spec: {
        prompt_md: 'follow-up',
        reference_md: 'follow-up reference',
      },
      probe_quality: {
        schema_version: 1,
        passed: true,
        final_review: { verdict: 'pass' },
      },
      discriminating: true,
      predicted_p: 0.3,
    };
    const seedProposal = async (id: string, proposedChange: Record<string, JSONValue>) => {
      const payload = {
        ai_proposal: {
          kind: 'conjecture',
          proposed_change: proposedChange,
        },
      };
      await client`
        INSERT INTO event (
          id, actor_kind, actor_ref, action, subject_kind, subject_id,
          outcome, payload, affected_scopes, created_at
        ) VALUES (
          ${id}, 'agent', 'research_meeting', 'experimental:proposal',
          'mind_model', ${id}, 'partial', ${client.json(payload)},
          ARRAY['topic:test']::text[], '2026-07-01T00:00:00Z'::timestamptz
        )
      `;
    };

    await seedProposal('legacy_pending', {
      probe_md: 'legacy',
      probe_reference_md: 'legacy reference',
      discriminating: true,
      predicted_p: 0.3,
    });
    await seedProposal('legacy_decided', {
      probe_md: 'legacy',
      probe_reference_md: 'legacy reference',
      discriminating: true,
      predicted_p: 0.3,
    });
    await seedProposal('v3_pending', v3Change);
    await client`
      INSERT INTO event (
        id, actor_kind, actor_ref, action, subject_kind, subject_id,
        outcome, payload, caused_by_event_id, affected_scopes, created_at
      ) VALUES (
        'legacy_decision', 'user', 'self', 'rate', 'event', 'legacy_decided',
        'success', '{"rating":"accept"}'::jsonb, 'legacy_decided',
        ARRAY[]::text[], '2026-07-02T00:00:00Z'::timestamptz
      )
    `;

    const migration = orderedMigrations().find((entry) => entry.tag === MIGRATION_TAG);
    if (!migration) throw new Error(`migration ${MIGRATION_TAG} not found`);
    await applyMigrationFile(migration.sql);
    await applyMigrationFile(migration.sql);

    const corrections = await client<
      {
        subject_id: string;
        actor_kind: string;
        actor_ref: string;
        payload: unknown;
        affected_scopes: string[];
        already_ingested: boolean;
      }[]
    >`
      SELECT subject_id, actor_kind, actor_ref, payload, affected_scopes,
             ingest_at IS NOT NULL AS already_ingested
      FROM event
      WHERE actor_ref = 'yuk821_legacy_migration'
      ORDER BY subject_id
    `;
    expect(corrections).toEqual([
      {
        subject_id: 'legacy_pending',
        actor_kind: 'agent',
        actor_ref: 'yuk821_legacy_migration',
        affected_scopes: [],
        already_ingested: true,
        payload: {
          correction_kind: 'retract',
          reason_md: 'Legacy conjecture retired: no YUK-821 verified diagnostic/probe package.',
          affected_refs: [{ kind: 'open_inquiry', id: 'legacy_pending' }],
        },
      },
    ]);

    const ownerDismissals = await client<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM event
      WHERE action = 'rate'
        AND payload ->> 'rating' = 'dismiss'
        AND caused_by_event_id = 'legacy_pending'
    `;
    expect(ownerDismissals[0]?.count).toBe('0');
  });
});

describe('migration smoke — YUK-821 probe-quality audit binding', () => {
  const BASELINE_TAG = '0082_yuk821_retire_legacy_pending_conjectures';
  const MIGRATION_TAG = '0083_yuk821_bind_probe_quality_audit';
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;

  beforeAll(async () => {
    ensureDockerHost();
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    client = postgres(container.getConnectionUri(), { max: 1 });
    let reachedBaseline = false;
    for (const migration of orderedMigrations()) {
      await applyMigrationFile(client, migration.sql);
      if (migration.tag === BASELINE_TAG) {
        reachedBaseline = true;
        break;
      }
    }
    if (!reachedBaseline) throw new Error(`baseline migration ${BASELINE_TAG} not found`);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('retires the complete pre-binding pending set and is idempotent', async () => {
    const seedProposal = async (
      id: string,
      probeQuality: Record<string, JSONValue>,
      extraPayload: Record<string, JSONValue> = {},
    ) => {
      const payload = {
        ai_proposal: {
          kind: 'conjecture',
          evidence_refs: [{ kind: 'event', id: `${id}_attempt` }],
          proposed_change: { probe_quality: probeQuality },
        },
        ...extraPayload,
      };
      await client`
        INSERT INTO event (
          id, actor_kind, actor_ref, action, subject_kind, subject_id,
          outcome, payload, affected_scopes, created_at
        ) VALUES (
          ${id}, 'agent', 'research_meeting', 'experimental:proposal',
          'mind_model', ${id}, 'partial', ${client.json(payload)},
          ARRAY['topic:test']::text[], '2026-07-03T00:00:00Z'::timestamptz
        )
      `;
    };

    await seedProposal('prebinding_v1_pending', { schema_version: 1, passed: true });
    // Even a v2-shaped row visible before this migration is conservatively retired:
    // the v2 producer cannot start until the migrate init container succeeds.
    await seedProposal('prebinding_v2_shaped_pending', { schema_version: 2, passed: true });
    await seedProposal('prebinding_decided', { schema_version: 1, passed: true });
    await seedProposal('prebinding_already_retracted', { schema_version: 1, passed: true });
    await seedProposal('prebinding_malformed_latest_rate', {
      schema_version: 1,
      passed: true,
    });
    await seedProposal(
      'prebinding_string_false_rubric',
      { schema_version: 1, passed: true },
      { rubric_verdict: { ok: 'false' } },
    );
    await seedProposal(
      'prebinding_rubric_rejected',
      { schema_version: 1, passed: true },
      { rubric_verdict: { ok: false } },
    );

    await client`
      INSERT INTO event (
        id, actor_kind, actor_ref, action, subject_kind, subject_id,
        outcome, payload, caused_by_event_id, affected_scopes, created_at
      ) VALUES
      (
        'prebinding_decision', 'user', 'self', 'rate', 'event', 'prebinding_decided',
        'success', '{"rating":"accept"}'::jsonb, 'prebinding_decided',
        ARRAY[]::text[], '2026-07-04T00:00:00Z'::timestamptz
      ),
      (
        'prebinding_existing_retraction', 'agent', 'prior_migration', 'correct',
        'event', 'prebinding_already_retracted', 'success',
        '{"correction_kind":"retract"}'::jsonb, 'prebinding_already_retracted',
        ARRAY[]::text[], '2026-07-04T00:00:00Z'::timestamptz
      ),
      (
        'prebinding_old_valid_rate', 'user', 'self', 'rate', 'event',
        'prebinding_malformed_latest_rate', 'success',
        '{"rating":"accept"}'::jsonb, 'prebinding_malformed_latest_rate',
        ARRAY[]::text[], '2026-07-04T00:00:00Z'::timestamptz
      ),
      (
        'prebinding_new_malformed_rate', 'user', 'self', 'rate', 'event',
        'prebinding_malformed_latest_rate', 'success',
        '{"rating":"unknown"}'::jsonb, 'prebinding_malformed_latest_rate',
        ARRAY[]::text[], '2026-07-05T00:00:00Z'::timestamptz
      )
    `;

    const migration = orderedMigrations().find((entry) => entry.tag === MIGRATION_TAG);
    if (!migration) throw new Error(`migration ${MIGRATION_TAG} not found`);
    await applyMigrationFile(client, migration.sql);
    await applyMigrationFile(client, migration.sql);

    const corrections = await client<
      {
        subject_id: string;
        actor_kind: string;
        actor_ref: string;
        affected_scopes: string[];
        already_ingested: boolean;
      }[]
    >`
      SELECT subject_id, actor_kind, actor_ref, affected_scopes,
             ingest_at IS NOT NULL AS already_ingested
      FROM event
      WHERE actor_ref = 'yuk821_audit_binding_migration'
      ORDER BY subject_id
    `;
    expect(corrections).toEqual([
      {
        subject_id: 'prebinding_already_retracted',
        actor_kind: 'agent',
        actor_ref: 'yuk821_audit_binding_migration',
        affected_scopes: [],
        already_ingested: true,
      },
      {
        subject_id: 'prebinding_malformed_latest_rate',
        actor_kind: 'agent',
        actor_ref: 'yuk821_audit_binding_migration',
        affected_scopes: [],
        already_ingested: true,
      },
      {
        subject_id: 'prebinding_string_false_rubric',
        actor_kind: 'agent',
        actor_ref: 'yuk821_audit_binding_migration',
        affected_scopes: [],
        already_ingested: true,
      },
      {
        subject_id: 'prebinding_v1_pending',
        actor_kind: 'agent',
        actor_ref: 'yuk821_audit_binding_migration',
        affected_scopes: [],
        already_ingested: true,
      },
      {
        subject_id: 'prebinding_v2_shaped_pending',
        actor_kind: 'agent',
        actor_ref: 'yuk821_audit_binding_migration',
        affected_scopes: [],
        already_ingested: true,
      },
    ]);

    const ownerDismissals = await client<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM event
      WHERE action = 'rate'
        AND payload ->> 'rating' = 'dismiss'
        AND caused_by_event_id IN ('prebinding_v1_pending', 'prebinding_v2_shaped_pending')
    `;
    expect(ownerDismissals[0]?.count).toBe('0');
  });
});

describe('migration smoke — YUK-827 response-signature cutover', () => {
  const BASELINE_TAG = '0083_yuk821_bind_probe_quality_audit';
  const MIGRATION_TAG = '0084_yuk827_response_signature_cutover';
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;

  beforeAll(async () => {
    ensureDockerHost();
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    client = postgres(container.getConnectionUri(), { max: 1 });
    let reachedBaseline = false;
    for (const migration of orderedMigrations()) {
      await applyMigrationFile(client, migration.sql);
      if (migration.tag === BASELINE_TAG) {
        reachedBaseline = true;
        break;
      }
    }
    if (!reachedBaseline) throw new Error(`baseline migration ${BASELINE_TAG} not found`);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('retires all pre-cutover pending conjectures without creating an owner dismissal', async () => {
    const seedProposal = async (
      id: string,
      schemaVersion: number,
      actorKind: 'agent' | 'user' = 'agent',
    ) => {
      await client`
        INSERT INTO event (
          id, actor_kind, actor_ref, action, subject_kind, subject_id,
          outcome, payload, affected_scopes, created_at
        ) VALUES (
          ${id}, ${actorKind}, 'research_meeting', 'experimental:proposal',
          'mind_model', ${id}, 'partial',
          ${client.json({
            ai_proposal: {
              kind: 'conjecture',
              evidence_refs: [{ kind: 'event', id: `${id}_attempt` }],
              proposed_change: {
                probe_quality: { schema_version: schemaVersion, passed: true },
              },
            },
          })},
          ARRAY['topic:test']::text[], '2026-07-29T00:00:00Z'::timestamptz
        )
      `;
    };

    await seedProposal('response_signature_v2_pending', 2);
    await seedProposal('response_signature_v3_shaped_pending', 3);
    await seedProposal('response_signature_decided', 2);
    await seedProposal('response_signature_owner_pending', 2, 'user');
    await seedProposal('response_signature_retracted', 2);
    await seedProposal('response_signature_superseded', 2);
    await seedProposal('response_signature_restored', 2);
    await client`
      INSERT INTO event (
        id, actor_kind, actor_ref, action, subject_kind, subject_id,
        outcome, payload, caused_by_event_id, affected_scopes, created_at
      ) VALUES
      (
        'response_signature_decision', 'user', 'self', 'rate', 'event',
        'response_signature_decided', 'success', '{"rating":"accept"}'::jsonb,
        'response_signature_decided', ARRAY[]::text[],
        '2026-07-29T01:00:00Z'::timestamptz
      ),
      (
        'response_signature_existing_retract', 'user', 'self', 'correct', 'event',
        'response_signature_retracted', 'success',
        '{"correction_kind":"retract"}'::jsonb,
        'response_signature_retracted', ARRAY[]::text[],
        '2026-07-29T01:00:00Z'::timestamptz
      ),
      (
        'response_signature_existing_supersede', 'agent', 'research_meeting',
        'correct', 'event', 'response_signature_superseded', 'success',
        '{"correction_kind":"supersede","replacement_event_id":"replacement"}'::jsonb,
        'response_signature_superseded', ARRAY[]::text[],
        '2026-07-29T01:00:00Z'::timestamptz
      ),
      (
        'response_signature_old_retract', 'agent', 'research_meeting', 'correct',
        'event', 'response_signature_restored', 'success',
        '{"correction_kind":"retract"}'::jsonb,
        'response_signature_restored', ARRAY[]::text[],
        '2026-07-29T01:00:00Z'::timestamptz
      ),
      (
        'response_signature_latest_restore', 'user', 'self', 'correct', 'event',
        'response_signature_restored', 'success',
        '{"correction_kind":"restore"}'::jsonb,
        'response_signature_restored', ARRAY[]::text[],
        '2026-07-29T02:00:00Z'::timestamptz
      )
    `;

    const migration = orderedMigrations().find((entry) => entry.tag === MIGRATION_TAG);
    if (!migration) throw new Error(`migration ${MIGRATION_TAG} not found`);
    await applyMigrationFile(client, migration.sql);
    await applyMigrationFile(client, migration.sql);

    const corrections = await client<
      {
        subject_id: string;
        actor_kind: string;
        actor_ref: string;
        affected_scopes: string[];
        already_ingested: boolean;
      }[]
    >`
      SELECT subject_id, actor_kind, actor_ref, affected_scopes,
             ingest_at IS NOT NULL AS already_ingested
      FROM event
      WHERE actor_ref = 'yuk827_response_signature_migration'
      ORDER BY subject_id
    `;
    expect(corrections).toEqual([
      {
        subject_id: 'response_signature_restored',
        actor_kind: 'agent',
        actor_ref: 'yuk827_response_signature_migration',
        affected_scopes: [],
        already_ingested: true,
      },
      {
        subject_id: 'response_signature_v2_pending',
        actor_kind: 'agent',
        actor_ref: 'yuk827_response_signature_migration',
        affected_scopes: [],
        already_ingested: true,
      },
      {
        subject_id: 'response_signature_v3_shaped_pending',
        actor_kind: 'agent',
        actor_ref: 'yuk827_response_signature_migration',
        affected_scopes: [],
        already_ingested: true,
      },
    ]);

    const ownerDismissals = await client<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM event
      WHERE action = 'rate'
        AND payload ->> 'rating' = 'dismiss'
        AND caused_by_event_id IN (
          'response_signature_v2_pending',
          'response_signature_v3_shaped_pending'
        )
    `;
    expect(ownerDismissals[0]?.count).toBe('0');
  });
});
describe('migration smoke — YUK-791 intervention preparation', () => {
  const BASELINE_TAG = '0084_yuk827_response_signature_cutover';
  const MIGRATION_TAG = '0085_yuk791_intervention_preparation';
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;

  beforeAll(async () => {
    ensureDockerHost();
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    client = postgres(container.getConnectionUri(), { max: 1 });
    let reachedBaseline = false;
    for (const migration of orderedMigrations()) {
      await applyMigrationFile(client, migration.sql);
      if (migration.tag === BASELINE_TAG) {
        reachedBaseline = true;
        break;
      }
    }
    if (!reachedBaseline) throw new Error(`baseline migration ${BASELINE_TAG} not found`);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('creates the versioned aggregate and enforces fail-closed terminal shapes', async () => {
    const migration = orderedMigrations().find((entry) => entry.tag === MIGRATION_TAG);
    if (!migration) throw new Error(`migration ${MIGRATION_TAG} not found`);
    await applyMigrationFile(client, migration.sql);

    await client`
      INSERT INTO event (
        id, actor_kind, actor_ref, action, subject_kind, subject_id,
        outcome, payload, affected_scopes
      )
      SELECT id, 'system', 'yuk791_migration_smoke', 'experimental:yuk791_fixture',
             'event', id, 'success', '{}'::jsonb, ARRAY[]::text[]
      FROM unnest(ARRAY[
        'probe_result_a', 'probe_result_b', 'probe_result_bad',
        'conjecture_a', 'conjecture_bad'
      ]::text[]) AS ids(id)
    `;

    await client`
      INSERT INTO intervention (
        id, version, source_probe_result_event_id, conjecture_event_id,
        status, delivery_mode, idempotency_key, snapshot_json
      ) VALUES (
        'int_a', 1, 'probe_result_a', 'conjecture_a',
        'preparing', 'shadow', 'idem_a', '{}'::jsonb
      )
    `;

    await expect(
      client`
        INSERT INTO intervention (
          id, version, source_probe_result_event_id, conjecture_event_id,
          status, delivery_mode, idempotency_key, snapshot_json
        ) VALUES (
          'int_dangling_source', 1, 'missing_probe_result', 'conjecture_a',
          'preparing', 'shadow', 'idem_dangling_source', '{}'::jsonb
        )
      `,
    ).rejects.toMatchObject({
      code: '23503',
      constraint_name: 'intervention_source_probe_result_event_fk',
    });

    await expect(
      client`
        INSERT INTO intervention (
          id, version, source_probe_result_event_id, conjecture_event_id,
          status, delivery_mode, idempotency_key, snapshot_json
        ) VALUES (
          'int_dangling_conjecture', 1, 'probe_result_b', 'missing_conjecture',
          'preparing', 'shadow', 'idem_dangling_conjecture', '{}'::jsonb
        )
      `,
    ).rejects.toMatchObject({
      code: '23503',
      constraint_name: 'intervention_conjecture_event_fk',
    });

    await expect(
      client`
        INSERT INTO intervention (
          id, version, source_probe_result_event_id, conjecture_event_id,
          status, delivery_mode, idempotency_key, snapshot_json
        ) VALUES (
          'int_a', 2, 'probe_result_b', 'conjecture_a',
          'preparing', 'shadow', 'idem_b', '{}'::jsonb
        )
      `,
    ).rejects.toMatchObject({
      code: '23505',
      constraint_name: 'intervention_one_preparing_version_uq',
    });

    await expect(
      client`
        INSERT INTO intervention (
          id, version, source_probe_result_event_id, conjecture_event_id,
          status, delivery_mode, idempotency_key, snapshot_json, activated_at
        ) VALUES (
          'int_bad_active', 1, 'probe_result_bad', 'conjecture_bad',
          'active', 'shadow', 'idem_bad', '{}'::jsonb, now()
        )
      `,
    ).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'intervention_active_shape_ck',
    });

    await client`
      UPDATE intervention
      SET status = 'active',
          recommendation_json = '{"kind":"recommendation"}'::jsonb,
          package_json = '{}'::jsonb,
          activated_at = now()
      WHERE id = 'int_a' AND version = 1
    `;
    await client`
      INSERT INTO intervention (
        id, version, source_probe_result_event_id, conjecture_event_id,
        status, delivery_mode, idempotency_key, snapshot_json
      ) VALUES (
        'int_a', 2, 'probe_result_b', 'conjecture_a',
        'preparing', 'shadow', 'idem_b', '{}'::jsonb
      )
    `;

    await expect(
      client`
        UPDATE intervention
        SET status = 'preparation_failed', failure_code = NULL
        WHERE id = 'int_a' AND version = 2
      `,
    ).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'intervention_failed_shape_ck',
    });

    const rows = await client<
      { id: string; version: number; status: string; delivery_mode: string }[]
    >`
      SELECT id, version, status, delivery_mode
      FROM intervention
      ORDER BY id, version
    `;
    expect(rows).toEqual([
      { id: 'int_a', version: 1, status: 'active', delivery_mode: 'shadow' },
      { id: 'int_a', version: 2, status: 'preparing', delivery_mode: 'shadow' },
    ]);
  });
});

describe('migration smoke — YUK-792 intervention settlement backfill', () => {
  const BASELINE_TAG = '0085_yuk791_intervention_preparation';
  const MIGRATION_TAG = '0086_yuk792_intervention_settlement';
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;

  beforeAll(async () => {
    ensureDockerHost();
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    client = postgres(container.getConnectionUri(), { max: 1 });
    let reachedBaseline = false;
    for (const migration of orderedMigrations()) {
      await applyMigrationFile(client, migration.sql);
      if (migration.tag === BASELINE_TAG) {
        reachedBaseline = true;
        break;
      }
    }
    if (!reachedBaseline) throw new Error(`baseline migration ${BASELINE_TAG} not found`);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('rebases eligible delivery clocks while preserving shadow audit clocks in UTC', async () => {
    await client`SET TIME ZONE 'Asia/Shanghai'`;
    await client`
      INSERT INTO event (
        id, actor_kind, actor_ref, action, subject_kind, subject_id,
        outcome, payload, affected_scopes
      ) VALUES
        (
          'yuk792_probe', 'system', 'yuk792_migration_smoke',
          'experimental:yuk792_fixture', 'question', 'yuk792_question',
          'success', '{}'::jsonb, ARRAY[]::text[]
        ),
        (
          'yuk792_probe_shadow', 'system', 'yuk792_migration_smoke',
          'experimental:yuk792_fixture', 'question', 'yuk792_question_shadow',
          'success', '{}'::jsonb, ARRAY[]::text[]
        ),
        (
          'yuk792_conjecture', 'system', 'yuk792_migration_smoke',
          'experimental:yuk792_fixture', 'knowledge', 'yuk792_kc',
          'success', '{}'::jsonb, ARRAY[]::text[]
        )
    `;
    await client`
      INSERT INTO intervention (
        id, version, source_probe_result_event_id, conjecture_event_id,
        status, delivery_mode, idempotency_key, snapshot_json,
        recommendation_json, package_json, activated_at
      ) VALUES
        (
          'int_yuk792_eligible', 1, 'yuk792_probe', 'yuk792_conjecture',
          'active', 'eligible', 'idem_yuk792_eligible', '{}'::jsonb,
          '{"kind":"recommendation"}'::jsonb, '{}'::jsonb,
          '2026-07-01 10:20:30.123+08'::timestamptz
        ),
        (
          'int_yuk792_shadow', 1, 'yuk792_probe_shadow', 'yuk792_conjecture',
          'active', 'shadow', 'idem_yuk792_shadow', '{}'::jsonb,
          '{"kind":"recommendation"}'::jsonb, '{}'::jsonb,
          '2026-07-01 10:20:30.123+08'::timestamptz
        )
    `;

    const migration = orderedMigrations().find((entry) => entry.tag === MIGRATION_TAG);
    if (!migration) throw new Error(`migration ${MIGRATION_TAG} not found`);
    const [before] = await client<{ now_ms: number }[]>`
      SELECT (extract(epoch FROM clock_timestamp()) * 1000)::double precision AS now_ms
    `;
    await applyMigrationFile(client, migration.sql);
    const [after] = await client<{ now_ms: number }[]>`
      SELECT (extract(epoch FROM clock_timestamp()) * 1000)::double precision AS now_ms
    `;

    const rows = await client<{ id: string; settlement_json: unknown }[]>`
      SELECT id, settlement_json
      FROM intervention
      WHERE id IN ('int_yuk792_eligible', 'int_yuk792_shadow') AND version = 1
      ORDER BY id
    `;
    const eligible = InterventionSettlement.parse(
      rows.find((row) => row.id === 'int_yuk792_eligible')?.settlement_json,
    );
    const eligibleAnchor = new Date(eligible.scheduled_at).getTime();
    expect(eligibleAnchor).toBeGreaterThanOrEqual((before?.now_ms ?? 0) - 1);
    expect(eligibleAnchor).toBeLessThanOrEqual((after?.now_ms ?? Number.POSITIVE_INFINITY) + 1);
    expect(eligible.diagnostics.immediate.due_at).toBe(eligible.scheduled_at);
    expect(new Date(eligible.diagnostics.delayed.due_at).getTime() - eligibleAnchor).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
    expect(new Date(eligible.diagnostics.transfer.due_at).getTime() - eligibleAnchor).toBe(
      21 * 24 * 60 * 60 * 1000,
    );

    const shadow = InterventionSettlement.parse(
      rows.find((row) => row.id === 'int_yuk792_shadow')?.settlement_json,
    );
    expect(shadow.scheduled_at).toBe('2026-07-01T02:20:30.123Z');
    expect(shadow.diagnostics.immediate.due_at).toBe('2026-07-01T02:20:30.123Z');
    expect(shadow.diagnostics.delayed.due_at).toBe('2026-07-08T02:20:30.123Z');
    expect(shadow.diagnostics.transfer.due_at).toBe('2026-07-22T02:20:30.123Z');
  });
});

describe('migration smoke — YUK-841 attempt cost truth', () => {
  const BASELINE_TAG = '0086_yuk792_intervention_settlement';
  const MIGRATION_TAG = '0087_yuk841_attempt_cost_truth';
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;

  beforeAll(async () => {
    ensureDockerHost();
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    client = postgres(container.getConnectionUri(), { max: 1 });
    let reachedBaseline = false;
    for (const migration of orderedMigrations()) {
      await applyMigrationFile(client, migration.sql);
      if (migration.tag === BASELINE_TAG) {
        reachedBaseline = true;
        break;
      }
    }
    if (!reachedBaseline) throw new Error(`baseline migration ${BASELINE_TAG} not found`);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('keeps old rows legacy and enforces nullable unknown + one ledger per attempt', async () => {
    await client`
      INSERT INTO ai_task_runs (
        id, task_kind, provider, model, input_hash, status, cost_usd, started_at, finished_at
      ) VALUES (
        'legacy_run', 'LegacyTask', 'legacy', 'legacy-model', 'legacy-hash',
        'success', 0, now(), now()
      )
    `;
    await client`
      INSERT INTO cost_ledger (
        id, task_run_id, task_kind, provider, model, cost, currency,
        tokens_in, tokens_out, outcome, occurred_at
      ) VALUES
        ('legacy_a', 'shared_run', 'LegacyTask', 'legacy', 'legacy-model', 0, 'USD', 1, 2, 'success', now()),
        ('legacy_b', 'shared_run', 'LegacyTask', 'legacy', 'legacy-model', 0.5, 'USD', 3, 4, 'success', now())
    `;

    const migration = orderedMigrations().find((entry) => entry.tag === MIGRATION_TAG);
    if (!migration) throw new Error(`migration ${MIGRATION_TAG} not found`);
    await applyMigrationFile(client, migration.sql);

    const legacy = await client<
      { id: string; entry_kind: string; cost_basis: string | null; cost_ref: string | null }[]
    >`
      SELECT id, entry_kind, cost_basis, cost_ref
      FROM cost_ledger
      WHERE id IN ('legacy_a', 'legacy_b')
      ORDER BY id
    `;
    expect(legacy).toEqual([
      { id: 'legacy_a', entry_kind: 'legacy', cost_basis: null, cost_ref: null },
      { id: 'legacy_b', entry_kind: 'legacy', cost_basis: null, cost_ref: null },
    ]);
    const [legacyRun] = await client<
      { id: string; cost_usd: number | null; cost_basis: string | null; cost_ref: string | null }[]
    >`
      SELECT id, cost_usd, cost_basis, cost_ref
      FROM ai_task_runs
      WHERE id = 'legacy_run'
    `;
    expect(legacyRun).toEqual({
      id: 'legacy_run',
      cost_usd: 0,
      cost_basis: null,
      cost_ref: null,
    });

    await client`
      INSERT INTO ai_task_runs (
        id, task_kind, provider, model, input_hash, status,
        cost_usd, cost_basis, cost_ref, started_at, finished_at
      ) VALUES
        ('run_reported', 'AttemptTask', 'anthropic', 'claude', 'reported-hash', 'success',
         0, 'reported', 'sdk:total_cost_usd', now(), now()),
        ('run_unknown', 'AttemptTask', 'xiaomi', 'unknown-model', 'unknown-hash', 'failure',
         NULL, 'unknown', 'unpriced:xiaomi/unknown-model', now(), now())
    `;

    await expect(
      client`
        INSERT INTO ai_task_runs (
          id, task_kind, provider, model, input_hash, status,
          cost_usd, cost_basis, cost_ref, started_at, finished_at
        ) VALUES (
          'run_half_truth', 'AttemptTask', 'xiaomi', 'mimo-v2.5-pro', 'half-hash', 'failure',
          NULL, NULL, 'pricebook:half', now(), now()
        )
      `,
    ).rejects.toMatchObject({ code: '23514', constraint_name: 'ai_task_runs_cost_truth_ck' });

    await expect(
      client`
        INSERT INTO ai_task_runs (
          id, task_kind, provider, model, input_hash, status,
          cost_usd, cost_basis, cost_ref, started_at, finished_at
        ) VALUES (
          'run_unknown_zero', 'AttemptTask', 'xiaomi', 'mimo-future', 'unknown-zero-hash', 'failure',
          0, 'unknown', 'unpriced:xiaomi/mimo-future', now(), now()
        )
      `,
    ).rejects.toMatchObject({ code: '23514', constraint_name: 'ai_task_runs_cost_truth_ck' });

    await expect(
      client`
        INSERT INTO ai_task_runs (
          id, task_kind, provider, model, input_hash, status,
          cost_usd, cost_basis, cost_ref, started_at, finished_at
        ) VALUES (
          'run_reported_null', 'AttemptTask', 'anthropic', 'claude', 'reported-null-hash', 'failure',
          NULL, 'reported', 'sdk:total_cost_usd', now(), now()
        )
      `,
    ).rejects.toMatchObject({ code: '23514', constraint_name: 'ai_task_runs_cost_truth_ck' });

    await client`
      INSERT INTO cost_ledger (
        id, task_run_id, task_kind, provider, model, cost, currency,
        entry_kind, cost_basis, cost_ref, tokens_in, tokens_out, outcome, occurred_at
      ) VALUES
        ('attempt_reported', 'attempt_run_1', 'AttemptTask', 'anthropic', 'claude', 0, 'USD',
         'attempt', 'reported', 'sdk:total_cost_usd', 0, 0, 'success', now()),
        ('attempt_unknown', 'attempt_run_2', 'AttemptTask', 'xiaomi', 'unknown-model', NULL, 'USD',
         'attempt', 'unknown', 'unpriced:xiaomi/unknown-model', 0, 0, 'failed_permanent', now())
    `;

    await expect(
      client`
        INSERT INTO cost_ledger (
          id, task_run_id, task_kind, provider, model, cost, currency,
          entry_kind, cost_basis, cost_ref, tokens_in, tokens_out, outcome, occurred_at
        ) VALUES (
          'attempt_duplicate', 'attempt_run_1', 'AttemptTask', 'anthropic', 'claude', 1, 'USD',
          'attempt', 'reported', 'sdk:total_cost_usd', 1, 1, 'success', now()
        )
      `,
    ).rejects.toMatchObject({ code: '23505', constraint_name: 'cost_ledger_attempt_task_run_uq' });

    await expect(
      client`
        INSERT INTO cost_ledger (
          id, task_run_id, task_kind, provider, model, cost, currency,
          entry_kind, cost_basis, cost_ref, tokens_in, tokens_out, outcome, occurred_at
        ) VALUES (
          'attempt_invalid_unknown', 'attempt_run_3', 'AttemptTask', 'xiaomi', 'unknown-model', 0, 'USD',
          'attempt', 'unknown', 'unpriced:xiaomi/unknown-model', 0, 0, 'failed_permanent', now()
        )
      `,
    ).rejects.toMatchObject({ code: '23514', constraint_name: 'cost_ledger_attempt_truth_ck' });
  });
});

describe('migration smoke — YUK-842 provider query-session admission foundation', () => {
  const BASELINE_TAG = '0087_yuk841_attempt_cost_truth';
  const MIGRATION_TAG = '0088_yuk842_provider_session_admission';
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;

  beforeAll(async () => {
    ensureDockerHost();
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    client = postgres(container.getConnectionUri(), { max: 1 });
    let reachedBaseline = false;
    for (const migration of orderedMigrations()) {
      await applyMigrationFile(client, migration.sql);
      if (migration.tag === BASELINE_TAG) {
        reachedBaseline = true;
        break;
      }
    }
    if (!reachedBaseline) throw new Error(`baseline migration ${BASELINE_TAG} not found`);
    const migration = orderedMigrations().find((entry) => entry.tag === MIGRATION_TAG);
    if (!migration) throw new Error(`migration ${MIGRATION_TAG} not found`);
    await applyMigrationFile(client, migration.sql);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('creates the loose-ref operational table and lane/rate/pruning indexes', async () => {
    const columns = await client<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'provider_session_admission'
    `;
    expect(new Set(columns.map((row) => row.column_name))).toEqual(
      new Set([
        'task_run_id',
        'lane_id',
        'policy_fingerprint',
        'mode',
        'status',
        'borrowed_from_task_run_id',
        'claim_token',
        'requested_at',
        'wait_deadline_at',
        'acquired_at',
        'heartbeat_at',
        'lease_expires_at',
        'hard_reclaim_at',
        'terminal_at',
        'terminal_reason',
      ]),
    );

    const indexes = await client<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'provider_session_admission'
    `;
    const byName = new Map(indexes.map((row) => [row.indexname, row.indexdef]));
    for (const name of [
      'provider_session_admission_pkey',
      'provider_session_admission_lane_active_idx',
      'provider_session_admission_lane_lease_idx',
      'provider_session_admission_lane_start_idx',
      'provider_session_admission_lane_waiting_idx',
      'provider_session_admission_borrowed_from_idx',
      'provider_session_admission_lane_terminal_idx',
    ]) {
      expect(byName.has(name), name).toBe(true);
    }
    expect(byName.get('provider_session_admission_lane_active_idx')).toMatch(
      /status.*acquired.*lease_expired/i,
    );
    expect(byName.get('provider_session_admission_lane_terminal_idx')).toMatch(
      /\(lane_id, terminal_at\)/i,
    );

    const foreignKeys = await client<{ constraint_name: string }[]>`
      SELECT constraint_name
      FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = 'provider_session_admission'
        AND constraint_type = 'FOREIGN KEY'
    `;
    expect(foreignKeys).toEqual([]);
  });

  it('accepts waiting, acquired, borrowed, released, and hard-reclaim quarantine shapes', async () => {
    await client`
      INSERT INTO provider_session_admission (
        task_run_id, lane_id, policy_fingerprint, mode, status,
        requested_at, wait_deadline_at
      ) VALUES (
        'run_waiting', 'xiaomi:primary', 'policy:v1', 'observe', 'waiting',
        '2026-08-03T00:00:00Z', '2026-08-03T00:01:00Z'
      )
    `;
    await client`
      INSERT INTO provider_session_admission (
        task_run_id, lane_id, policy_fingerprint, mode, status, claim_token,
        requested_at, wait_deadline_at, acquired_at, heartbeat_at,
        lease_expires_at, hard_reclaim_at
      ) VALUES (
        'run_parent', 'xiaomi:primary', 'policy:v1', 'enforce', 'acquired',
        '00000000-0000-4000-8000-000000000001',
        '2026-08-03T00:00:00Z', '2026-08-03T00:01:00Z',
        '2026-08-03T00:00:01Z', '2026-08-03T00:00:02Z',
        '2026-08-03T00:00:32Z', '2026-08-03T00:06:00Z'
      )
    `;
    await client`
      INSERT INTO provider_session_admission (
        task_run_id, lane_id, policy_fingerprint, mode, status,
        borrowed_from_task_run_id, claim_token,
        requested_at, wait_deadline_at, acquired_at, heartbeat_at,
        lease_expires_at, hard_reclaim_at
      ) VALUES (
        'run_child_active', 'xiaomi:primary', 'policy:v1', 'enforce', 'acquired',
        'run_parent', '00000000-0000-4000-8000-000000000002',
        '2026-08-03T00:00:03Z', '2026-08-03T00:01:03Z',
        '2026-08-03T00:00:04Z', '2026-08-03T00:00:05Z',
        '2026-08-03T00:00:35Z', '2026-08-03T00:06:03Z'
      )
    `;
    await client`
      INSERT INTO provider_session_admission (
        task_run_id, lane_id, policy_fingerprint, mode, status,
        borrowed_from_task_run_id, claim_token,
        requested_at, wait_deadline_at, acquired_at, heartbeat_at,
        lease_expires_at, hard_reclaim_at, terminal_at, terminal_reason
      ) VALUES
        (
          'run_child_released', 'xiaomi:primary', 'policy:v1', 'enforce', 'released',
          'run_parent', '00000000-0000-4000-8000-000000000003',
          '2026-08-03T00:00:06Z', '2026-08-03T00:01:06Z',
          '2026-08-03T00:00:07Z', '2026-08-03T00:00:08Z',
          '2026-08-03T00:00:38Z', '2026-08-03T00:06:06Z',
          '2026-08-03T00:00:20Z', 'session_finished'
        ),
        (
          'run_child_expired', 'xiaomi:primary', 'policy:v1', 'enforce', 'lease_expired',
          'run_parent', '00000000-0000-4000-8000-000000000004',
          '2026-08-03T00:00:09Z', '2026-08-03T00:01:09Z',
          '2026-08-03T00:00:10Z', '2026-08-03T00:00:11Z',
          '2026-08-03T00:00:41Z', '2026-08-03T00:06:09Z',
          '2026-08-03T00:00:42Z', 'heartbeat_lost'
        )
    `;

    const rows = await client<{ task_run_id: string; borrowed_from_task_run_id: string | null }[]>`
      SELECT task_run_id, borrowed_from_task_run_id
      FROM provider_session_admission
      ORDER BY task_run_id
    `;
    expect(rows).toHaveLength(5);
    expect(rows.find((row) => row.task_run_id === 'run_child_active')).toMatchObject({
      borrowed_from_task_run_id: 'run_parent',
    });
  });

  it('rejects impossible acquisition, terminal, timeline, and borrowing shapes', async () => {
    await expect(
      client`
        INSERT INTO provider_session_admission (
          task_run_id, lane_id, policy_fingerprint, mode, status,
          borrowed_from_task_run_id, requested_at, wait_deadline_at
        ) VALUES (
          'bad_wait_borrow', 'xiaomi:primary', 'policy:v1', 'enforce', 'waiting',
          'run_parent', '2026-08-03T01:00:00Z', '2026-08-03T01:01:00Z'
        )
      `,
    ).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'provider_session_admission_borrow_shape_ck',
    });

    await expect(
      client`
        INSERT INTO provider_session_admission (
          task_run_id, lane_id, policy_fingerprint, mode, status, claim_token,
          requested_at, wait_deadline_at, acquired_at, heartbeat_at, lease_expires_at
        ) VALUES (
          'bad_partial_lease', 'xiaomi:primary', 'policy:v1', 'enforce', 'acquired',
          '00000000-0000-4000-8000-000000000005',
          '2026-08-03T01:00:00Z', '2026-08-03T01:01:00Z',
          '2026-08-03T01:00:01Z', '2026-08-03T01:00:02Z', '2026-08-03T01:00:32Z'
        )
      `,
    ).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'provider_session_admission_acquisition_shape_ck',
    });

    await expect(
      client`
        INSERT INTO provider_session_admission (
          task_run_id, lane_id, policy_fingerprint, mode, status, claim_token,
          requested_at, wait_deadline_at, acquired_at, heartbeat_at,
          lease_expires_at, hard_reclaim_at, terminal_at
        ) VALUES (
          'bad_terminal_shape', 'xiaomi:primary', 'policy:v1', 'enforce', 'released',
          '00000000-0000-4000-8000-000000000007',
          '2026-08-03T01:00:00Z', '2026-08-03T01:01:00Z',
          '2026-08-03T01:00:01Z', '2026-08-03T01:00:02Z',
          '2026-08-03T01:00:32Z', '2026-08-03T01:06:00Z', '2026-08-03T01:00:10Z'
        )
      `,
    ).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'provider_session_admission_terminal_shape_ck',
    });

    await expect(
      client`
        INSERT INTO provider_session_admission (
          task_run_id, lane_id, policy_fingerprint, mode, status,
          requested_at, wait_deadline_at, terminal_at, terminal_reason
        ) VALUES (
          'bad_early_timeout', 'xiaomi:primary', 'policy:v1', 'enforce', 'timed_out',
          '2026-08-03T01:00:00Z', '2026-08-03T01:01:00Z',
          '2026-08-03T01:00:30Z', 'wait_timeout'
        )
      `,
    ).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'provider_session_admission_timeline_ck',
    });

    await expect(
      client`
        INSERT INTO provider_session_admission (
          task_run_id, lane_id, policy_fingerprint, mode, status, claim_token,
          borrowed_from_task_run_id, requested_at, wait_deadline_at,
          acquired_at, heartbeat_at, lease_expires_at, hard_reclaim_at
        ) VALUES (
          'bad_self_borrow', 'xiaomi:primary', 'policy:v1', 'enforce', 'acquired',
          '00000000-0000-4000-8000-000000000006', 'bad_self_borrow',
          '2026-08-03T01:00:00Z', '2026-08-03T01:01:00Z',
          '2026-08-03T01:00:01Z', '2026-08-03T01:00:02Z',
          '2026-08-03T01:00:32Z', '2026-08-03T01:06:00Z'
        )
      `,
    ).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'provider_session_admission_borrow_shape_ck',
    });
  });
});

describe('migration smoke — YUK-851 provider attempt lifecycle', () => {
  const BASELINE_TAG = '0088_yuk842_provider_session_admission';
  const MIGRATION_TAG = '0089_yuk851_provider_attempt_lifecycle';
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let baselineSignature: unknown;

  beforeAll(async () => {
    ensureDockerHost();
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    client = postgres(container.getConnectionUri(), { max: 1 });
    for (const migration of orderedMigrations()) {
      await applyMigrationFile(client, migration.sql);
      if (migration.tag === BASELINE_TAG) break;
    }
    baselineSignature = await client`
      SELECT table_name, column_name, ordinal_position, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `;
    const migration = orderedMigrations().find((entry) => entry.tag === MIGRATION_TAG);
    if (!migration) throw new Error(`migration ${MIGRATION_TAG} not found`);
    await applyMigrationFile(client, migration.sql);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('creates exact columns, indexes, checks, and no foreign keys', async () => {
    const columns = await client<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('provider_attempt', 'provider_attempt_admission')
    `;
    const byTable = Map.groupBy(columns, (row) => row.table_name);
    expect(new Set(byTable.get('provider_attempt')?.map((row) => row.column_name))).toEqual(
      new Set([
        'attempt_id',
        'operation_id',
        'attempt_kind',
        'provider',
        'model',
        'lane_id',
        'protocol',
        'endpoint_class',
        'caller',
        'operation_kind',
        'external_request_id',
        'terminal_status',
        'terminal_reason',
        'wire_count',
        'usage_json',
        'cost_basis',
        'cost_amount',
        'cost_currency',
        'cost_source',
        'started_at',
        'provider_start_reserved_at',
        'finished_at',
      ]),
    );
    expect(
      new Set(byTable.get('provider_attempt_admission')?.map((row) => row.column_name)),
    ).toEqual(
      new Set([
        'attempt_id',
        'identity_fingerprint',
        'policy_fingerprint',
        'lane_id',
        'mode',
        'status',
        'lease_owner',
        'requested_at',
        'deadline_at',
        'acquired_at',
        'lease_expires_at',
        'terminal_at',
        'terminal_reason',
      ]),
    );
    const indexes = await client<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename IN ('provider_attempt', 'provider_attempt_admission')
    `;
    expect(new Set(indexes.map((row) => row.indexname))).toEqual(
      new Set([
        'provider_attempt_pkey',
        'provider_attempt_operation_idx',
        'provider_attempt_open_operation_idx',
        'provider_attempt_external_request_idx',
        'provider_attempt_admission_pkey',
        'provider_attempt_admission_lane_active_idx',
        'provider_attempt_admission_lane_start_idx',
        'provider_attempt_admission_lane_terminal_idx',
      ]),
    );
    const indexDefinition = new Map(indexes.map((row) => [row.indexname, row.indexdef]));
    expect(indexDefinition.get('provider_attempt_operation_idx')).toContain(
      '(operation_id, started_at DESC, attempt_id)',
    );
    expect(indexDefinition.get('provider_attempt_open_operation_idx')).toContain(
      '(operation_id, lane_id, started_at DESC) WHERE (finished_at IS NULL)',
    );
    expect(indexDefinition.get('provider_attempt_external_request_idx')).toContain(
      '(provider, external_request_id) WHERE (external_request_id IS NOT NULL)',
    );
    expect(indexDefinition.get('provider_attempt_admission_lane_active_idx')).toContain(
      "WHERE (status = ANY (ARRAY['acquired'::text, 'would_deny'::text]))",
    );
    expect(indexDefinition.get('provider_attempt_admission_lane_start_idx')).toContain(
      'WHERE (acquired_at IS NOT NULL)',
    );
    expect(indexDefinition.get('provider_attempt_admission_lane_terminal_idx')).toContain(
      'WHERE (terminal_at IS NOT NULL)',
    );
    const checks = await client<{ constraint_name: string }[]>`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name IN ('provider_attempt', 'provider_attempt_admission')
        AND constraint_type = 'CHECK'
        AND constraint_name LIKE 'provider_attempt_%'
    `;
    expect(new Set(checks.map((row) => row.constraint_name))).toEqual(
      new Set([
        'provider_attempt_kind_ck',
        'provider_attempt_caller_ck',
        'provider_attempt_terminal_ck',
        'provider_attempt_identity_ck',
        'provider_attempt_wire_ck',
        'provider_attempt_opaque_ck',
        'provider_attempt_terminal_shape_ck',
        'provider_attempt_cost_shape_ck',
        'provider_attempt_timeline_ck',
        'provider_attempt_admission_identity_ck',
        'provider_attempt_admission_state_ck',
      ]),
    );
    const foreignKeys = await client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name IN ('provider_attempt', 'provider_attempt_admission')
        AND constraint_type = 'FOREIGN KEY'
    `;
    expect(foreignKeys[0]?.count).toBe(0);
  });

  it('accepts valid unfinished, wire terminal, opaque terminal, and active admission shapes', async () => {
    await client`
      INSERT INTO provider_attempt (
        attempt_id, operation_id, attempt_kind, provider, model, lane_id, protocol,
        endpoint_class, caller, operation_kind, started_at
      ) VALUES (
        '00000000-0000-4000-8000-000000000871',
        '00000000-0000-4000-8000-000000000872',
        'wire', 'xiaomi', NULL, 'generation', 'anthropic', 'messages', 'api', 'Task', now()
      )
    `;
    await client`
      INSERT INTO provider_attempt (
        attempt_id, operation_id, attempt_kind, provider, model, lane_id, protocol,
        endpoint_class, caller, operation_kind, terminal_status, terminal_reason,
        wire_count, usage_json, cost_basis, cost_amount, cost_currency, cost_source,
        started_at, finished_at
      ) VALUES (
        '00000000-0000-4000-8000-000000000873',
        '00000000-0000-4000-8000-000000000872',
        'wire', 'xiaomi', 'mimo', 'generation', 'anthropic', 'messages', 'worker', 'Task',
        'succeeded', 'completed', 0,
        '{"basis":"reported","unit":"tokens","input":0,"output":null,"total":null,"source":"sdk"}',
        'reported', 0, 'USD', 'sdk', now(), now()
      )
    `;
    await client`
      INSERT INTO provider_attempt (
        attempt_id, operation_id, attempt_kind, provider, model, lane_id, protocol,
        endpoint_class, caller, operation_kind, terminal_status, terminal_reason,
        wire_count, usage_json, cost_basis, cost_amount, cost_currency, cost_source,
        started_at, finished_at
      ) VALUES (
        '00000000-0000-4000-8000-000000000874',
        '00000000-0000-4000-8000-000000000872',
        'opaque_operation', 'anthropic', 'claude', 'opaque', 'sdk', 'query', 'worker',
        'OpaqueTask', 'unknown', 'opaque operation', NULL,
        '{"basis":"unknown","unit":null,"input":null,"output":null,"total":null,"source":"sdk"}',
        'unknown', NULL, NULL, 'pricebook', now(), now()
      )
    `;
    await client`
      INSERT INTO provider_attempt_admission (
        attempt_id, identity_fingerprint, policy_fingerprint, lane_id, mode, status,
        lease_owner, requested_at, deadline_at, acquired_at, lease_expires_at
      ) VALUES (
        '00000000-0000-4000-8000-000000000871', 'identity', 'policy', 'generation',
        'enforce', 'acquired', '00000000-0000-4000-8000-000000000875',
        now(), now() + interval '1 minute', now(), now() + interval '1 minute'
      )
    `;
  });

  it.each([
    [
      'provider_attempt_kind_ck',
      `INSERT INTO provider_attempt (attempt_id,operation_id,attempt_kind,provider,lane_id,protocol,endpoint_class,caller,operation_kind,started_at) VALUES ('00000000-0000-4000-8000-000000000881','00000000-0000-4000-8000-000000000880','bad','p','l','p','e','api','o',now())`,
    ],
    [
      'provider_attempt_caller_ck',
      `INSERT INTO provider_attempt (attempt_id,operation_id,attempt_kind,provider,lane_id,protocol,endpoint_class,caller,operation_kind,started_at) VALUES ('00000000-0000-4000-8000-000000000882','00000000-0000-4000-8000-000000000880','wire','p','l','p','e','cron','o',now())`,
    ],
    [
      'provider_attempt_terminal_ck',
      `INSERT INTO provider_attempt (attempt_id,operation_id,attempt_kind,provider,lane_id,protocol,endpoint_class,caller,operation_kind,terminal_status,terminal_reason,usage_json,cost_basis,cost_source,started_at,finished_at) VALUES ('00000000-0000-4000-8000-000000000891','00000000-0000-4000-8000-000000000880','wire','p','l','p','e','api','o','bad','done','{"basis":"unknown","unit":null,"input":null,"output":null,"total":null,"source":"s"}','unknown','s',now(),now())`,
    ],
    [
      'provider_attempt_identity_ck',
      `INSERT INTO provider_attempt (attempt_id,operation_id,attempt_kind,provider,lane_id,protocol,endpoint_class,caller,operation_kind,started_at) VALUES ('00000000-0000-4000-8000-000000000883','00000000-0000-4000-8000-000000000880','wire',' ','l','p','e','api','o',now())`,
    ],
    [
      'provider_attempt_wire_ck',
      `INSERT INTO provider_attempt (attempt_id,operation_id,attempt_kind,provider,lane_id,protocol,endpoint_class,caller,operation_kind,terminal_status,terminal_reason,wire_count,usage_json,cost_basis,cost_source,started_at,finished_at) VALUES ('00000000-0000-4000-8000-000000000884','00000000-0000-4000-8000-000000000880','wire','p','l','p','e','api','o','unknown','done',-1,'{"basis":"unknown","unit":null,"input":null,"output":null,"total":null,"source":"s"}','unknown','s',now(),now())`,
    ],
    [
      'provider_attempt_opaque_ck',
      `INSERT INTO provider_attempt (attempt_id,operation_id,attempt_kind,provider,lane_id,protocol,endpoint_class,caller,operation_kind,terminal_status,terminal_reason,wire_count,usage_json,cost_basis,cost_source,started_at,finished_at) VALUES ('00000000-0000-4000-8000-000000000885','00000000-0000-4000-8000-000000000880','opaque_operation','p','l','p','e','api','o','unknown','done',1,'{"basis":"unknown","unit":null,"input":null,"output":null,"total":null,"source":"s"}','unknown','s',now(),now())`,
    ],
    [
      'provider_attempt_terminal_shape_ck',
      `INSERT INTO provider_attempt (attempt_id,operation_id,attempt_kind,provider,lane_id,protocol,endpoint_class,caller,operation_kind,terminal_status,started_at) VALUES ('00000000-0000-4000-8000-000000000886','00000000-0000-4000-8000-000000000880','wire','p','l','p','e','api','o','failed',now())`,
    ],
    [
      'provider_attempt_cost_shape_ck',
      `INSERT INTO provider_attempt (attempt_id,operation_id,attempt_kind,provider,lane_id,protocol,endpoint_class,caller,operation_kind,terminal_status,terminal_reason,usage_json,cost_basis,cost_amount,cost_source,started_at,finished_at) VALUES ('00000000-0000-4000-8000-000000000887','00000000-0000-4000-8000-000000000880','wire','p','l','p','e','api','o','unknown','done','{"basis":"unknown","unit":null,"input":null,"output":null,"total":null,"source":"s"}','unknown',0,'s',now(),now())`,
    ],
    [
      'provider_attempt_timeline_ck',
      `INSERT INTO provider_attempt (attempt_id,operation_id,attempt_kind,provider,lane_id,protocol,endpoint_class,caller,operation_kind,terminal_status,terminal_reason,usage_json,cost_basis,cost_source,started_at,finished_at) VALUES ('00000000-0000-4000-8000-000000000888','00000000-0000-4000-8000-000000000880','wire','p','l','p','e','api','o','unknown','done','{"basis":"unknown","unit":null,"input":null,"output":null,"total":null,"source":"s"}','unknown','s','2026-01-02','2026-01-01')`,
    ],
    [
      'provider_attempt_timeline_ck',
      `INSERT INTO provider_attempt (attempt_id,operation_id,attempt_kind,provider,lane_id,protocol,endpoint_class,caller,operation_kind,started_at,provider_start_reserved_at) VALUES ('00000000-0000-4000-8000-000000000896','00000000-0000-4000-8000-000000000880','wire','p','l','p','e','api','o','2026-01-02','2026-01-01')`,
    ],
    [
      'provider_attempt_timeline_ck',
      `INSERT INTO provider_attempt (attempt_id,operation_id,attempt_kind,provider,lane_id,protocol,endpoint_class,caller,operation_kind,terminal_status,terminal_reason,usage_json,cost_basis,cost_source,started_at,provider_start_reserved_at,finished_at) VALUES ('00000000-0000-4000-8000-000000000897','00000000-0000-4000-8000-000000000880','wire','p','l','p','e','api','o','unknown','done','{"basis":"unknown","unit":null,"input":null,"output":null,"total":null,"source":"s"}','unknown','s','2026-01-01','2026-01-03','2026-01-02')`,
    ],
    [
      'provider_attempt_admission_identity_ck',
      `INSERT INTO provider_attempt_admission (attempt_id,identity_fingerprint,policy_fingerprint,lane_id,mode,status,requested_at,deadline_at,terminal_at,terminal_reason) VALUES ('00000000-0000-4000-8000-000000000889',' ','p','l','enforce','denied',now(),now(),'2026-01-01','denied')`,
    ],
    [
      'provider_attempt_admission_state_ck',
      `INSERT INTO provider_attempt_admission (attempt_id,identity_fingerprint,policy_fingerprint,lane_id,mode,status,requested_at,deadline_at) VALUES ('00000000-0000-4000-8000-000000000890','i','p','l','enforce','acquired',now(),now())`,
    ],
    [
      'provider_attempt_admission_state_ck',
      `INSERT INTO provider_attempt_admission (attempt_id,identity_fingerprint,policy_fingerprint,lane_id,mode,status,lease_owner,requested_at,deadline_at,acquired_at,lease_expires_at) VALUES ('00000000-0000-4000-8000-000000000892','i','p','l','enforce','acquired','00000000-0000-4000-8000-000000000899',now(),now(),now(),now()+interval '1 second')`,
    ],
    [
      'provider_attempt_admission_state_ck',
      `INSERT INTO provider_attempt_admission (attempt_id,identity_fingerprint,policy_fingerprint,lane_id,mode,status,lease_owner,requested_at,deadline_at,acquired_at,lease_expires_at) VALUES ('00000000-0000-4000-8000-000000000893','i','p','l','enforce','would_deny','00000000-0000-4000-8000-000000000899',now(),now(),now(),now()+interval '1 second')`,
    ],
    [
      'provider_attempt_admission_state_ck',
      `INSERT INTO provider_attempt_admission (attempt_id,identity_fingerprint,policy_fingerprint,lane_id,mode,status,requested_at,deadline_at,terminal_at,terminal_reason) VALUES ('00000000-0000-4000-8000-000000000894','i','p','l','observe','denied',now(),now(),now(),'denied')`,
    ],
    [
      'provider_attempt_admission_state_ck',
      `INSERT INTO provider_attempt_admission (attempt_id,identity_fingerprint,policy_fingerprint,lane_id,mode,status,lease_owner,requested_at,deadline_at,acquired_at,lease_expires_at,terminal_at,terminal_reason) VALUES ('00000000-0000-4000-8000-000000000895','i','p','l','enforce','lease_expired','00000000-0000-4000-8000-000000000899',now(),now()+interval '2 seconds',now(),now()+interval '2 seconds',now()+interval '1 second','expired')`,
    ],
  ])('rejects invalid rows through named check %s', async (constraintName, statement) => {
    await expect(client.unsafe(statement)).rejects.toMatchObject({
      code: '23514',
      constraint_name: constraintName,
    });
  });

  it('leaves every pre-0089 table column signature unchanged', async () => {
    const after = await client`
      SELECT table_name, column_name, ordinal_position, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name NOT IN ('provider_attempt', 'provider_attempt_admission')
      ORDER BY table_name, ordinal_position
    `;
    expect(after).toEqual(baselineSignature);
  });
});

describe('migration smoke — YUK-844 placement unknown cost', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;

  beforeAll(async () => {
    ensureDockerHost();
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    client = postgres(container.getConnectionUri(), { max: 1 });
    for (const migration of orderedMigrations()) {
      if (migration.tag === '0090_yuk844_placement_unknown_cost') break;
      await applyMigrationFile(client, migration.sql);
    }
    await client`
      INSERT INTO placement_starter_claim (
        id, fingerprint, goal_id, semantic_goal_revision_id, subject_id,
        knowledge_id, demand_id, target_id, status, pg_boss_job_id,
        known_cost_micro_usd, created_at, updated_at
      ) VALUES (
        'migration-yuk844-claim', 'migration-yuk844-fingerprint', 'migration-yuk844-goal',
        'migration-yuk844-revision', 'yuwen', 'migration-yuk844-knowledge',
        'migration-yuk844-demand', 'migration-yuk844-target', 'running',
        'migration-yuk844-job', 250, now(), now()
      )
    `;
    await client`
      INSERT INTO placement_starter_attempt (
        id, claim_id, pg_boss_job_id, delivery_no, fencing_token, status,
        lease_expires_at, created_at, updated_at
      ) VALUES (
        'migration-yuk844-attempt', 'migration-yuk844-claim', 'migration-yuk844-job', 1,
        '00000000-0000-4000-8000-000000000844', 'running', now() + interval '1 hour',
        now(), now()
      )
    `;
    await client`
      INSERT INTO placement_starter_cost_component (
        id, claim_id, attempt_id, component_kind, provider_task_run_id,
        cost_micro_usd, created_at
      ) VALUES
        (
          'migration-yuk844-known', 'migration-yuk844-claim', 'migration-yuk844-attempt',
          'quiz_gen', 'migration-yuk844-known-run', 250, now()
        ),
        (
          'migration-yuk844-generation-boundary', 'migration-yuk844-claim',
          'migration-yuk844-attempt', 'quiz_gen',
          'migration-yuk844-generation-boundary-run', 500000, now()
        ),
        (
          'migration-yuk844-generation-over', 'migration-yuk844-claim',
          'migration-yuk844-attempt', 'quiz_gen',
          'migration-yuk844-generation-over-run', 500001, now()
        ),
        (
          'migration-yuk844-paid-boundary', 'migration-yuk844-claim',
          'migration-yuk844-attempt', 'solution_check',
          'migration-yuk844-paid-boundary-run', 100000, now()
        ),
        (
          'migration-yuk844-paid-over', 'migration-yuk844-claim',
          'migration-yuk844-attempt', 'teaching_quality',
          'migration-yuk844-paid-over-run', 100001, now()
        ),
        (
          'migration-yuk844-reservation', 'migration-yuk844-claim',
          'migration-yuk844-attempt', 'quiz_verify',
          'reservation:migration-yuk844-existing', 100000, now()
        )
    `;
    const migration = orderedMigrations().find(
      (entry) => entry.tag === '0090_yuk844_placement_unknown_cost',
    );
    if (!migration) throw new Error('migration 0090_yuk844_placement_unknown_cost not found');
    await applyMigrationFile(client, migration.sql);
  }, 90_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('preserves numeric history and accepts canonical settlement dispositions', async () => {
    const [claim] = await client<{ known_cost_micro_usd: number | null }[]>`
      SELECT known_cost_micro_usd FROM placement_starter_claim
      WHERE id = 'migration-yuk844-claim'
    `;
    const components = await client<
      { id: string; cost_micro_usd: number | null; over_cap: boolean | null }[]
    >`
      SELECT id, cost_micro_usd, over_cap FROM placement_starter_cost_component
      WHERE claim_id = 'migration-yuk844-claim'
    `;
    const componentsById = new Map(components.map((component) => [component.id, component]));
    expect(claim?.known_cost_micro_usd).toBe(250);
    expect(componentsById.get('migration-yuk844-known')).toMatchObject({
      cost_micro_usd: 250,
      over_cap: false,
    });
    expect(componentsById.get('migration-yuk844-generation-boundary')?.over_cap).toBe(false);
    expect(componentsById.get('migration-yuk844-generation-over')?.over_cap).toBe(true);
    expect(componentsById.get('migration-yuk844-paid-boundary')?.over_cap).toBe(false);
    expect(componentsById.get('migration-yuk844-paid-over')?.over_cap).toBe(true);
    expect(componentsById.get('migration-yuk844-reservation')?.over_cap).toBeNull();
    await client`
      INSERT INTO placement_starter_cost_component (
        id, claim_id, attempt_id, component_kind, provider_task_run_id,
        cost_micro_usd, created_at
      ) VALUES (
        'migration-yuk844-unknown', 'migration-yuk844-claim', 'migration-yuk844-attempt',
        'quiz_verify', 'migration-yuk844-unknown-run', NULL, now()
      )
    `;
    await client`
      INSERT INTO placement_starter_cost_component (
        id, claim_id, attempt_id, component_kind, provider_task_run_id,
        cost_micro_usd, over_cap, created_at
      ) VALUES
        (
          'migration-yuk844-within-cap', 'migration-yuk844-claim',
          'migration-yuk844-attempt', 'solution_check',
          'migration-yuk844-within-cap-run', 400, false, now()
        ),
        (
          'migration-yuk844-over-cap', 'migration-yuk844-claim',
          'migration-yuk844-attempt', 'teaching_quality',
          'migration-yuk844-over-cap-run', 700, true, now()
        )
    `;
    await client`
      UPDATE placement_starter_claim SET known_cost_micro_usd = NULL
      WHERE id = 'migration-yuk844-claim'
    `;
  });

  it('rejects nullable reservations and negative settled or claim costs', async () => {
    await expect(client`
      INSERT INTO placement_starter_cost_component (
        id, claim_id, attempt_id, component_kind, provider_task_run_id,
        cost_micro_usd, created_at
      ) VALUES (
        'migration-yuk844-null-reservation', 'migration-yuk844-claim',
        'migration-yuk844-attempt', 'solution_check', 'reservation:migration-yuk844',
        NULL, now()
      )
    `).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'placement_starter_cost_component_nonnegative',
    });
    await expect(client`
      INSERT INTO placement_starter_cost_component (
        id, claim_id, attempt_id, component_kind, provider_task_run_id,
        cost_micro_usd, over_cap, created_at
      ) VALUES (
        'migration-yuk844-reservation-disposition', 'migration-yuk844-claim',
        'migration-yuk844-attempt', 'solution_check',
        'reservation:migration-yuk844-disposition', 100, false, now()
      )
    `).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'placement_starter_cost_component_over_cap_check',
    });
    await expect(client`
      INSERT INTO placement_starter_cost_component (
        id, claim_id, attempt_id, component_kind, provider_task_run_id,
        cost_micro_usd, over_cap, created_at
      ) VALUES (
        'migration-yuk844-unknown-disposition', 'migration-yuk844-claim',
        'migration-yuk844-attempt', 'quiz_verify',
        'migration-yuk844-unknown-disposition-run', NULL, true, now()
      )
    `).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'placement_starter_cost_component_over_cap_check',
    });
    await expect(client`
      INSERT INTO placement_starter_cost_component (
        id, claim_id, attempt_id, component_kind, provider_task_run_id,
        cost_micro_usd, created_at
      ) VALUES (
        'migration-yuk844-negative', 'migration-yuk844-claim',
        'migration-yuk844-attempt', 'teaching_quality', 'migration-yuk844-negative-run',
        -1, now()
      )
    `).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'placement_starter_cost_component_nonnegative',
    });
    await expect(client`
      UPDATE placement_starter_claim SET known_cost_micro_usd = -1
      WHERE id = 'migration-yuk844-claim'
    `).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'placement_starter_claim_nonnegative_cost',
    });
  });
});

describe('migration smoke — YUK-855 provider attempt off mode', () => {
  const BASELINE_TAG = '0090_yuk844_placement_unknown_cost';
  const MIGRATION_TAG = '0091_yuk855_provider_attempt_off_mode';
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;

  beforeAll(async () => {
    ensureDockerHost();
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    client = postgres(container.getConnectionUri(), { max: 1 });
    for (const migration of orderedMigrations()) {
      await applyMigrationFile(client, migration.sql);
      if (migration.tag === BASELINE_TAG) break;
    }
    await client`
      INSERT INTO provider_attempt_admission (
        attempt_id, identity_fingerprint, policy_fingerprint, lane_id, mode, status,
        lease_owner, requested_at, deadline_at, acquired_at, lease_expires_at
      ) VALUES (
        '00000000-0000-4000-8000-000000000991', 'existing-identity', 'existing-policy',
        'glm.memory-reconcile', 'observe', 'acquired',
        '00000000-0000-4000-8000-000000000992', now(), now() + interval '2 minutes',
        now(), now() + interval '1 minute'
      )
    `;
    const migration = orderedMigrations().find((entry) => entry.tag === MIGRATION_TAG);
    if (!migration) throw new Error(`migration ${MIGRATION_TAG} not found`);
    await applyMigrationFile(client, migration.sql);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('preserves existing admission rows and accepts off acquired through release', async () => {
    const existing = await client<
      { attempt_id: string; lease_owner: string | null; mode: string; status: string }[]
    >`
      SELECT attempt_id::text, lease_owner::text, mode, status
      FROM provider_attempt_admission
      WHERE attempt_id = '00000000-0000-4000-8000-000000000991'
    `;
    expect(existing).toEqual([
      {
        attempt_id: '00000000-0000-4000-8000-000000000991',
        lease_owner: '00000000-0000-4000-8000-000000000992',
        mode: 'observe',
        status: 'acquired',
      },
    ]);

    await client`
      INSERT INTO provider_attempt_admission (
        attempt_id, identity_fingerprint, policy_fingerprint, lane_id, mode, status,
        lease_owner, requested_at, deadline_at, acquired_at, lease_expires_at
      ) VALUES (
        '00000000-0000-4000-8000-000000000993', 'off-identity', 'off-policy',
        'glm.memory-reconcile', 'off', 'acquired',
        '00000000-0000-4000-8000-000000000994', now(), now() - interval '1 second',
        now(), now() + interval '30 seconds'
      )
    `;
    await client`
      UPDATE provider_attempt_admission
      SET status = 'released', terminal_at = now(), terminal_reason = 'attempt_finished'
      WHERE attempt_id = '00000000-0000-4000-8000-000000000993'
    `;
    const released = await client<
      { lease_owner: string | null; mode: string; status: string; terminal_reason: string | null }[]
    >`
      SELECT lease_owner::text, mode, status, terminal_reason
      FROM provider_attempt_admission
      WHERE attempt_id = '00000000-0000-4000-8000-000000000993'
    `;
    expect(released).toEqual([
      {
        lease_owner: '00000000-0000-4000-8000-000000000994',
        mode: 'off',
        status: 'released',
        terminal_reason: 'attempt_finished',
      },
    ]);
  });

  it.each([
    [
      'would_deny',
      `INSERT INTO provider_attempt_admission (attempt_id,identity_fingerprint,policy_fingerprint,lane_id,mode,status,lease_owner,requested_at,deadline_at,acquired_at,lease_expires_at) VALUES ('00000000-0000-4000-8000-000000000995','i','p','l','off','would_deny','00000000-0000-4000-8000-000000000997',now(),now()+interval '1 minute',now(),now()+interval '30 seconds')`,
    ],
    [
      'denied',
      `INSERT INTO provider_attempt_admission (attempt_id,identity_fingerprint,policy_fingerprint,lane_id,mode,status,requested_at,deadline_at,terminal_at,terminal_reason) VALUES ('00000000-0000-4000-8000-000000000996','i','p','l','off','denied',now(),now(),now(),'denied')`,
    ],
  ])('rejects off %s through the state constraint', async (_status, statement) => {
    await expect(client.unsafe(statement)).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'provider_attempt_admission_state_ck',
    });
  });
});
