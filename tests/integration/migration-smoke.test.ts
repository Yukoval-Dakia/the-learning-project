// Each migration baseline owns a fresh pgvector/Postgres 16 container,
// independent of tests/global-setup.ts. Only disposable storage uses tmpfs;
// SQL, populated backfills, constraints and PostgreSQL durability settings remain.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type JSONValue } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InterventionSettlement } from '@/core/schema/intervention';
import { KNOWN_SUBJECT_IDS } from '@/subjects/profile';

const execFileAsync = promisify(execFile);

// Public barrel changes must also survive the shipped CJS startup, not just
// source-level imports or drizzle's SQL-only migration path below.
describe('migration bundle — public ports and repeated startup', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;

  beforeAll(async () => {
    ensureDockerHost();
    await execFileAsync('pnpm', ['--config.verify-deps-before-run=false', 'build:migrate'], {
      timeout: 60_000,
    });
    container = await migrationContainer().start();
    client = postgres(container.getConnectionUri(), { max: 1 });
  }, 90_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('starts against an empty DB and preserves subject roots on a second run', async () => {
    const run = () =>
      execFileAsync(process.execPath, ['dist/migrate.cjs'], {
        env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
        timeout: 60_000,
      });
    const first = await run();
    expect(first.stdout).toContain('[migrate] Copilot legacy drain readiness: clear');
    expect(first.stdout).toContain('[migrate] contract epoch:');
    const roots = () => client`
      SELECT id, name, parent_id, created_at, updated_at, version
      FROM knowledge WHERE id = ANY(${KNOWN_SUBJECT_IDS.map((id) => `seed:${id}:root`)})
      ORDER BY id
    `;
    const before = await roots();
    expect(before.map((row) => row.id)).toEqual(
      KNOWN_SUBJECT_IDS.map((id) => `seed:${id}:root`).sort(),
    );
    expect(before.every((row) => row.parent_id === null)).toBe(true);

    const second = await run();
    expect(second.stdout).toContain('[migrate] subject-root seed: +0 inserted');
    expect(await roots()).toEqual(before);
  }, 120_000);
});

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

function migrationContainer() {
  return new PostgreSqlContainer('pgvector/pgvector:pg16').withTmpFs({
    '/var/lib/postgresql/data': 'rw,size=2g',
  });
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
    container = await migrationContainer().start();
    client = postgres(container.getConnectionUri(), { max: 1 });
    db = drizzle(client);

    // Apply all migrations from ./drizzle in journal order
    await migrate(db, { migrationsFolder: './drizzle' });
  }, 90_000); // Container cold start and the complete migration chain.

  afterAll(async () => {
    await client?.end();
    await container?.stop();
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
    container = await migrationContainer().start();
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
    container = await migrationContainer().start();
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
    container = await migrationContainer().start();
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
    container = await migrationContainer().start();
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
    container = await migrationContainer().start();
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
    container = await migrationContainer().start();
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
    container = await migrationContainer().start();
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
    container = await migrationContainer().start();
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

describe('migration smoke — YUK-851 provider attempt lifecycle', () => {
  const BASELINE_TAG = '0088_yuk842_provider_session_admission';
  const MIGRATION_TAG = '0089_yuk851_provider_attempt_lifecycle';
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let baselineSignature: unknown;

  beforeAll(async () => {
    ensureDockerHost();
    container = await migrationContainer().start();
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
    container = await migrationContainer().start();
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
});

describe('migration smoke — YUK-855 provider attempt off mode', () => {
  const BASELINE_TAG = '0090_yuk844_placement_unknown_cost';
  const MIGRATION_TAG = '0091_yuk855_provider_attempt_off_mode';
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;

  beforeAll(async () => {
    ensureDockerHost();
    container = await migrationContainer().start();
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
});

describe('migration smoke — YUK-857 note verification claim', () => {
  const BASELINE_TAG = '0092_yuk855_provider_attempt_start_rate_index';
  const MIGRATION_TAG = '0093_yuk857_note_verification_claim';
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;

  beforeAll(async () => {
    ensureDockerHost();
    container = await migrationContainer().start();
    client = postgres(container.getConnectionUri(), { max: 1 });
    for (const migration of orderedMigrations()) {
      await applyMigrationFile(client, migration.sql);
      if (migration.tag === BASELINE_TAG) break;
    }
    const migration = orderedMigrations().find((entry) => entry.tag === MIGRATION_TAG);
    if (!migration) throw new Error(`migration ${MIGRATION_TAG} not found`);
    await applyMigrationFile(client, migration.sql);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('rejects duplicate non-null verification task run ids', async () => {
    await client`
      INSERT INTO artifact (id,type,title,intent_source,source,generation_status,verification_status,created_at,updated_at)
      VALUES
        ('claim-task-run-a','note_atomic','Claim A','test','test','ready','queued',now(),now()),
        ('claim-task-run-b','note_atomic','Claim B','test','test','ready','queued',now(),now())
    `;
    await client`
      INSERT INTO note_verification_claim (
        artifact_id,artifact_version,state,fence,claim_token,task_run_id,
        available_at,lease_expires_at,created_at,updated_at
      ) VALUES (
        'claim-task-run-a',0,'reserved',1,'11111111-1111-4111-8111-111111111111',
        'note-verify-duplicate-run',now(),now() + interval '2 minutes',now(),now()
      )
    `;
    await expect(client`
      INSERT INTO note_verification_claim (
        artifact_id,artifact_version,state,fence,claim_token,task_run_id,
        available_at,lease_expires_at,created_at,updated_at
      ) VALUES (
        'claim-task-run-b',0,'reserved',1,'22222222-2222-4222-8222-222222222222',
        'note-verify-duplicate-run',now(),now() + interval '2 minutes',now(),now()
      )
    `).rejects.toMatchObject({ code: '23505' });
  });
});

describe('migration smoke — YUK-1044 assessment contract truth source', () => {
  // 0104 建表；0105（复审）FK/trigger/选择位；0106（终验）head 三坐标 FK；
  // 0107（CI 修复）restore 通道 GUC + 自 FK deferrable。
  const FINAL_TAG = '0107_yuk1044_backup_restore_channel';
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;

  beforeAll(async () => {
    ensureDockerHost();
    container = await migrationContainer().start();
    client = postgres(container.getConnectionUri(), { max: 1 });
    for (const migration of orderedMigrations()) {
      await applyMigrationFile(client, migration.sql);
      if (migration.tag === FINAL_TAG) break;
    }
    // 贯穿用 fixture：rev_a / iss_head(/rev_a) / eg_head + sub_head + head。
    await insertRevision('rev_a', 1);
    await insertIssuance('iss_head', 'rev_a');
    await insertGroupSubmissionHead('eg_head', 'sub_head', 'idem-head');
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  // ---- coherent fixture helpers（P1-2：所有身份坐标必须真实存在且互相一致）----

  async function insertRevision(
    revisionId: string,
    ordinal: number,
    groupId = 'grp_smoke',
  ): Promise<void> {
    await client`
      INSERT INTO question_revision (
        revision_id, group_id, revision_ordinal, integrity_digest,
        structure, response_spec, scoring_basis, execution_plan,
        availability, published_at
      ) VALUES (
        ${revisionId}, ${groupId}, ${ordinal}, ${`sha256:${revisionId}`},
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        'general_pool', now()
      )
    `;
  }

  async function insertIssuance(
    issuanceId: string,
    revisionId: string,
    extra: { containerRef?: string } = {},
  ): Promise<void> {
    await client`
      INSERT INTO assessment_issuance (
        issuance_id, revision_id, part_ids, material_bindings, option_order,
        container_occurrence_ref, claim_policy, claim_status, issued_at
      ) VALUES (
        ${issuanceId}, ${revisionId}, '["p1"]'::jsonb, '[]'::jsonb, '[]'::jsonb,
        ${extra.containerRef ?? null}, 'unbounded', 'unclaimed', now()
      )
    `;
  }

  async function insertGroupSubmissionHead(
    groupId: string,
    submissionId: string,
    idempotencyKey: string,
    issuanceId = 'iss_head',
  ): Promise<void> {
    await client`
      INSERT INTO evaluation_group (evaluation_group_id, submission_ids, created_at)
      VALUES (${groupId}, jsonb_build_array(${submissionId}::text), now())
    `;
    await client`
      INSERT INTO assessment_submission (
        submission_id, issuance_id, revision_id, evaluation_group_id,
        response_set, idempotency_key, submitted_at
      ) VALUES (
        ${submissionId}, ${issuanceId}, 'rev_a', ${groupId},
        '{}'::jsonb, ${idempotencyKey}, now()
      )
    `;
    await client`
      INSERT INTO evaluation_effective_head (evaluation_group_id, submission_id, updated_at)
      VALUES (${groupId}, ${submissionId}, now())
    `;
  }

  it('question_revision identity is (group_id, revision_ordinal), never a global content hash key', async () => {
    // 同组同序数 ⇒ 唯一键拒绝（即使内容 digest 不同）。
    await expect(insertRevision('rev_b', 1)).rejects.toMatchObject({
      constraint_name: 'question_revision_group_ordinal_uq',
    });
    // 同 digest 不同组 ⇒ 允许（identity 不是全局内容 hash）。
    await insertRevision('rev_c', 1, 'grp_other');
    await insertRevision('rev_a2', 2, 'grp_other');
    // ordinal >= 1 CHECK。
    await expect(insertRevision('rev_d', 0, 'grp_third')).rejects.toMatchObject({
      constraint_name: 'question_revision_ordinal_positive_ck',
    });
  });

  // ---- P1-1：不可变事实的 DB 层防线 ----

  it('P1-1: immutable fact tables reject UPDATE and DELETE via triggers', async () => {
    await expect(client`
      UPDATE question_revision SET integrity_digest = 'digest-rewritten'
      WHERE revision_id = 'rev_a'
    `).rejects.toMatchObject({ code: 'P0001' });
    await expect(
      client`DELETE FROM question_revision WHERE revision_id = 'rev_a'`,
    ).rejects.toMatchObject({
      code: 'P0001',
    });
    await expect(client`
      UPDATE assessment_submission SET response_set = '{"entries":[]}'::jsonb
      WHERE submission_id = 'sub_head'
    `).rejects.toMatchObject({ code: 'P0001' });
    await expect(
      client`DELETE FROM assessment_submission WHERE submission_id = 'sub_head'`,
    ).rejects.toMatchObject({
      code: 'P0001',
    });
    await client`
      INSERT INTO question_admission_verification (
        id, revision_id, revision_digest, policy_id, generation, outcome, recorded_at
      ) VALUES ('v_imm', 'rev_a', 'sha256:rev_a', 'admission-policy@2026-09-24', 1, 'passed', now())
    `;
    await expect(client`
      UPDATE question_admission_verification SET outcome = 'failed' WHERE id = 'v_imm'
    `).rejects.toMatchObject({ code: 'P0001' });
    await expect(client`
      DELETE FROM question_admission_verification WHERE id = 'v_imm'
    `).rejects.toMatchObject({ code: 'P0001' });
  });

  it('P1-1: issuance binding fields are frozen; only claim columns may change', async () => {
    // claim 生命周期列可变。
    await client`
      UPDATE assessment_issuance SET claim_status = 'claimed', claimed_by_ref = 'session:tutor_1'
      WHERE issuance_id = 'iss_head'
    `;
    // 任一绑定列改动 ⇒ 拒绝。
    await expect(client`
      UPDATE assessment_issuance SET part_ids = '["p2"]'::jsonb WHERE issuance_id = 'iss_head'
    `).rejects.toMatchObject({ code: 'P0001' });
    await expect(client`
      UPDATE assessment_issuance SET revision_id = 'rev_a' WHERE issuance_id = 'iss_head'
    `).resolves.toBeDefined(); // 同值 UPDATE（IS NOT DISTINCT）不受影响
    // 终验收紧：claim_policy 是发题契约一部分，同样冻结（0106 替换函数体生效）。
    await expect(client`
      UPDATE assessment_issuance SET claim_policy = 'one_time' WHERE issuance_id = 'iss_head'
    `).rejects.toMatchObject({ code: 'P0001' });
    await expect(
      client`DELETE FROM assessment_issuance WHERE issuance_id = 'iss_head'`,
    ).rejects.toMatchObject({
      code: 'P0001',
    });
  });

  // ---- P1-2：FK + 冗余坐标一致性 ----

  it('P1-2: submissions require existing issuance/group and a revision that agrees with the issuance', async () => {
    await client`
      INSERT INTO evaluation_group (evaluation_group_id, submission_ids, created_at)
      VALUES ('eg_fk', '["sub_fk"]'::jsonb, now())
    `;
    // 不存在的 issuance ⇒ FK 拒绝。
    await expect(client`
      INSERT INTO assessment_submission (
        submission_id, issuance_id, revision_id, evaluation_group_id,
        response_set, idempotency_key, submitted_at
      ) VALUES ('sub_fk', 'iss_missing', 'rev_a', 'eg_fk', '{}'::jsonb, 'idem-fk', now())
    `).rejects.toMatchObject({ constraint_name: 'assessment_submission_issuance_revision_fk' });
    // 存在的 issuance 但 revision 坐标不一致 ⇒ 复合 FK 拒绝。
    await insertRevision('rev_fk', 1, 'grp_fk');
    await insertIssuance('iss_fk', 'rev_fk');
    await expect(client`
      INSERT INTO assessment_submission (
        submission_id, issuance_id, revision_id, evaluation_group_id,
        response_set, idempotency_key, submitted_at
      ) VALUES ('sub_fk', 'iss_fk', 'rev_a', 'eg_fk', '{}'::jsonb, 'idem-fk', now())
    `).rejects.toMatchObject({ constraint_name: 'assessment_submission_issuance_revision_fk' });
    // 一致坐标 ⇒ 接受。
    await client`
      INSERT INTO assessment_submission (
        submission_id, issuance_id, revision_id, evaluation_group_id,
        response_set, idempotency_key, submitted_at
      ) VALUES ('sub_fk', 'iss_fk', 'rev_fk', 'eg_fk', '{}'::jsonb, 'idem-fk', now())
    `;
  });

  it('P1-2: evaluations must belong to their submission; heads must point at evaluations of their own group', async () => {
    // 无关组的 evaluation ⇒ 复合 FK 拒绝（submission 属 eg_fk，evaluation 声称 eg_head）。
    await expect(client`
      INSERT INTO evaluation (evaluation_id, evaluation_group_id, submission_id, attempt, status, created_at)
      VALUES ('ev_owner', 'eg_head', 'sub_fk', 1, 'pending', now())
    `).rejects.toMatchObject({ constraint_name: 'evaluation_submission_group_fk' });
    // 一致的 (submission, group) ⇒ 接受。
    await client`
      INSERT INTO evaluation (evaluation_id, evaluation_group_id, submission_id, attempt, status, created_at)
      VALUES ('ev_fk_1', 'eg_fk', 'sub_fk', 1, 'completed', now())
    `;
    // head 指向他组的 evaluation ⇒ 复合 FK 拒绝（eg_head 的 head 不能指 ev_fk_1）。
    await expect(client`
      UPDATE evaluation_effective_head SET effective_evaluation_id = 'ev_fk_1', updated_at = now()
      WHERE evaluation_group_id = 'eg_head'
    `).rejects.toMatchObject({ constraint_name: 'evaluation_effective_head_evaluation_fk' });
  });

  it('P1-2: lifecycle current pointer must reference a revision of the same group', async () => {
    await client`
      INSERT INTO question_group_lifecycle (
        group_id, current_revision_id, availability,
        scoring_admission_state, scoring_admission_withheld_reason,
        scoring_admission_generation, claim_policy, created_at, updated_at
      ) VALUES (
        'grp_other', NULL, 'general_pool', 'withheld', 'unverified_rules',
        0, 'unbounded', now(), now()
      )
    `;
    await expect(client`
      UPDATE question_group_lifecycle SET current_revision_id = 'rev_a', updated_at = now()
      WHERE group_id = 'grp_other'
    `).rejects.toMatchObject({ constraint_name: 'question_group_lifecycle_current_revision_fk' });
    await client`
      UPDATE question_group_lifecycle SET current_revision_id = 'rev_c', updated_at = now()
      WHERE group_id = 'grp_other'
    `;
  });

  // ---- 有效 head：默认值 + CAS 谓词（窄声明） ----

  it('effective head columns default to effective=NULL / generation=0; stale CAS predicate updates 0 rows', async () => {
    // 窄声明（复审）：本用例只断言 DDL 默认值与一个手写 CAS 谓词的行为；
    // group/submission/head 的【同事务原子创建】、generation 单调性与并发
    // activation 串行化由事务性 writer 保证并须在 writer 落地时测试。
    const initial = await client<{ effective_evaluation_id: string | null; generation: number }[]>`
      SELECT effective_evaluation_id, generation FROM evaluation_effective_head
      WHERE evaluation_group_id = 'eg_head'
    `;
    expect(initial[0].effective_evaluation_id).toBeNull();
    expect(initial[0].generation).toBe(0);

    await client`
      INSERT INTO evaluation (evaluation_id, evaluation_group_id, submission_id, attempt, status, created_at)
      VALUES ('ev_head_1', 'eg_head', 'sub_head', 1, 'completed', now())
    `;
    const activated = await client`
      UPDATE evaluation_effective_head
      SET effective_evaluation_id = 'ev_head_1', generation = generation + 1, updated_at = now()
      WHERE evaluation_group_id = 'eg_head'
        AND effective_evaluation_id IS NULL AND generation = 0
      RETURNING 1
    `;
    expect(activated).toHaveLength(1);
    const stale = await client`
      UPDATE evaluation_effective_head
      SET effective_evaluation_id = 'ev_head_1', generation = generation + 1, updated_at = now()
      WHERE evaluation_group_id = 'eg_head'
        AND effective_evaluation_id IS NULL AND generation = 0
      RETURNING 1
    `;
    expect(stale).toHaveLength(0);
  });

  it('final P1: head submission coordinates are validated in all three reviewer repro shapes; NULL head + CAS stay legal', async () => {
    // 独立 fixture：gA/sA、gB/sB、gC/sC1+sC1b（同组两 submission）。
    const mkGroup = async (g: string, s: string) => {
      await client`
        INSERT INTO evaluation_group (evaluation_group_id, submission_ids, created_at)
        VALUES (${g}, jsonb_build_array(${s}::text), now())
      `;
    };
    const mkSub = async (g: string, s: string, key: string) => {
      await client`
        INSERT INTO assessment_submission (
          submission_id, issuance_id, revision_id, evaluation_group_id,
          response_set, idempotency_key, submitted_at
        ) VALUES (${s}, 'iss_head', 'rev_a', ${g}, '{}'::jsonb, ${key}, now())
      `;
    };
    await mkGroup('eg_p1a', 'sub_p1a');
    await mkSub('eg_p1a', 'sub_p1a', 'idem-p1a');
    await mkGroup('eg_p1b', 'sub_p1b');
    await mkSub('eg_p1b', 'sub_p1b', 'idem-p1b');
    await mkGroup('eg_p1c', 'sub_p1c1');
    await mkSub('eg_p1c', 'sub_p1c1', 'idem-p1c1');
    await mkSub('eg_p1c', 'sub_p1c1b', 'idem-p1c1b'); // 同组第二 submission
    await client`
      INSERT INTO evaluation (evaluation_id, evaluation_group_id, submission_id, attempt, status, created_at)
      VALUES ('ev_p1c1', 'eg_p1c', 'sub_p1c1', 1, 'completed', now())
    `;

    // repro 1：NULL-effective head 携带不存在的 (submission, group) —— 旧 schema
    // 唯一 FK 被 MATCH SIMPLE 跳过而放行；现在 (submission, group) FK 恒生效。
    await expect(client`
      INSERT INTO evaluation_effective_head (evaluation_group_id, submission_id, updated_at)
      VALUES ('eg_ghost', 'sub_ghost', now())
    `).rejects.toMatchObject({ constraint_name: 'evaluation_effective_head_submission_fk' });

    // repro 2：head 属 gB 但 submission_id 是他组（gA）的 —— 矛盾坐标拒绝。
    await expect(client`
      INSERT INTO evaluation_effective_head (evaluation_group_id, submission_id, updated_at)
      VALUES ('eg_p1b', 'sub_p1a', now())
    `).rejects.toMatchObject({ constraint_name: 'evaluation_effective_head_submission_fk' });

    // repro 3：head 换到同组另一 submission（sC1b）后挂 effective（属 sC1）——
    // 三坐标 (evaluation, submission, group) 不全一致，拒绝。
    await client`
      INSERT INTO evaluation_effective_head (evaluation_group_id, submission_id, updated_at)
      VALUES ('eg_p1c', 'sub_p1c1b', now())
    `; // (sC1b, gC) 是真实同组 pair —— FK1 通过（NULL effective 合法初始态）
    await expect(client`
      UPDATE evaluation_effective_head SET effective_evaluation_id = 'ev_p1c1', updated_at = now()
      WHERE evaluation_group_id = 'eg_p1c' AND submission_id = 'sub_p1c1b'
    `).rejects.toMatchObject({ constraint_name: 'evaluation_effective_head_evaluation_fk' });

    // 合法路径：NULL-effective 初始 head（真实 pair）+ 正确三坐标 CAS activation。
    await client`
      INSERT INTO evaluation_effective_head (evaluation_group_id, submission_id, updated_at)
      VALUES ('eg_p1a', 'sub_p1a', now())
    `;
    await client`
      INSERT INTO evaluation (evaluation_id, evaluation_group_id, submission_id, attempt, status, created_at)
      VALUES ('ev_p1a1', 'eg_p1a', 'sub_p1a', 1, 'completed', now())
    `;
    const activated = await client`
      UPDATE evaluation_effective_head
      SET effective_evaluation_id = 'ev_p1a1', generation = generation + 1, updated_at = now()
      WHERE evaluation_group_id = 'eg_p1a' AND effective_evaluation_id IS NULL AND generation = 0
      RETURNING 1
    `;
    expect(activated).toHaveLength(1);
  });

  it('evaluation attempts are unique per (submission, attempt); idempotency key scoped per group', async () => {
    await client`
      INSERT INTO evaluation (evaluation_id, evaluation_group_id, submission_id, attempt, status, created_at)
      VALUES ('ev_dup', 'eg_head', 'sub_head', 2, 'completed', now())
    `;
    await expect(client`
      INSERT INTO evaluation (evaluation_id, evaluation_group_id, submission_id, attempt, status, created_at)
      VALUES ('ev_dup2', 'eg_head', 'sub_head', 2, 'pending', now())
    `).rejects.toMatchObject({ constraint_name: 'evaluation_submission_attempt_uq' });

    await expect(client`
      INSERT INTO assessment_submission (
        submission_id, issuance_id, revision_id, evaluation_group_id,
        response_set, idempotency_key, submitted_at
      ) VALUES (
        'sub_head_2', 'iss_head', 'rev_a', 'eg_head',
        '{}'::jsonb, 'idem-head', now()
      )
    `).rejects.toMatchObject({ constraint_name: 'assessment_submission_group_idem_uq' });
  });

  // ---- P1-3 / P2-B：身份映射 ----

  async function insertMapping(
    mappingId: string,
    sourceId: string,
    status: string,
    opts: { targetRevision?: string; supersedes?: string; locator?: string } = {},
  ): Promise<unknown> {
    return client`
      INSERT INTO assessment_identity_mapping (
        mapping_id, source_kind, source_id, source_locator,
        original_question_id, target_revision_id, algorithm_version, status,
        supersedes_mapping_id, created_at
      ) VALUES (
        ${mappingId}, 'paper_answer', ${sourceId}, ${opts.locator ?? `paper.pt-slots[${sourceId}]`},
        'q_legacy_1', ${opts.targetRevision ?? null}, 'map-v1', ${status},
        ${opts.supersedes ?? null}, now()
      )
    `;
  }

  it('P1-3/P2-B: mapping status is adjudication-only; current selection is is_current; corrections preserve history', async () => {
    // locator 非空 + 非空白（终验收紧：纯空格同样拒绝，btrim）。
    await expect(
      insertMapping('map_nolocator', '10', 'pending', { locator: '' }),
    ).rejects.toMatchObject({
      constraint_name: 'assessment_identity_mapping_locator_nonempty_ck',
    });
    await expect(
      insertMapping('map_space', '13', 'pending', { locator: '   ' }),
    ).rejects.toMatchObject({
      constraint_name: 'assessment_identity_mapping_locator_nonempty_ck',
    });
    // mapped 必须带目标 revision；historical_unresolved 不得带目标（P2-B）。
    await expect(insertMapping('map_notarget', '11', 'mapped')).rejects.toMatchObject({
      constraint_name: 'assessment_identity_mapping_mapped_target_ck',
    });
    await expect(
      insertMapping('map_unres_target', '12', 'historical_unresolved', { targetRevision: 'rev_a' }),
    ).rejects.toMatchObject({
      constraint_name: 'assessment_identity_mapping_unresolved_no_target_ck',
    });
    await insertMapping('map_hist', '12', 'historical_unresolved');

    // 同 locator 只允许一条当前映射。
    await insertMapping('map_1', '20', 'mapped', { targetRevision: 'rev_a' });
    await expect(insertMapping('map_1b', '20', 'conflicted')).rejects.toMatchObject({
      constraint_name: 'assessment_identity_mapping_current_uq',
    });

    // 修正链：旧行 is_current=false（status=原样保留）；新行链 supersedes。
    // 从多种先前 status 修正：mapped → 新裁决；conflicted → 新裁决。
    await client`UPDATE assessment_identity_mapping SET is_current = false WHERE mapping_id = 'map_1'`;
    await insertMapping('map_2', '20', 'conflicted', { supersedes: 'map_1' });
    // 旧行的 status 不被改写 —— 历史裁决仍在。
    const preserved = await client<{ mapping_id: string; status: string; is_current: boolean }[]>`
      SELECT mapping_id, status, is_current FROM assessment_identity_mapping
      WHERE source_kind = 'paper_answer' AND source_id = '20'
      ORDER BY mapping_id
    `;
    expect(preserved).toEqual([
      { mapping_id: 'map_1', status: 'mapped', is_current: false },
      { mapping_id: 'map_2', status: 'conflicted', is_current: true },
    ]);

    // 再修正 conflicted → mapped：链目标必须存在（自 FK），旧 conflicted 保留。
    await client`UPDATE assessment_identity_mapping SET is_current = false WHERE mapping_id = 'map_2'`;
    await insertMapping('map_3', '20', 'mapped', { targetRevision: 'rev_a', supersedes: 'map_2' });
    const chain = await client<{ mapping_id: string; status: string; is_current: boolean }[]>`
      SELECT mapping_id, status, is_current FROM assessment_identity_mapping
      WHERE source_kind = 'paper_answer' AND source_id = '20'
      ORDER BY mapping_id
    `;
    expect(chain).toEqual([
      { mapping_id: 'map_1', status: 'mapped', is_current: false },
      { mapping_id: 'map_2', status: 'conflicted', is_current: false },
      { mapping_id: 'map_3', status: 'mapped', is_current: true },
    ]);
    // 链目标不存在 ⇒ 自 FK 拒绝。
    // 链目标不存在 ⇒ 自 FK 拒绝（PG 会截断 drizzle 默认长约束名，
    // 故断言 FK 违规码而非具体名字）。
    await client`UPDATE assessment_identity_mapping SET is_current = false WHERE mapping_id = 'map_3'`;
    await expect(
      insertMapping('map_4', '20', 'mapped', { targetRevision: 'rev_a', supersedes: 'map_ghost' }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('admission verification records (revision_id, digest, policy, generation); lifecycle carries the split dimensions', async () => {
    // 不存在的 revision ⇒ FK 拒绝（P1-2）。
    await expect(client`
      INSERT INTO question_admission_verification (
        id, revision_id, revision_digest, policy_id, generation, outcome, recorded_at
      ) VALUES ('v_missing', 'rev_ghost', 'sha256:x', 'p', 1, 'passed', now())
    `).rejects.toMatchObject({ constraint_name: 'question_admission_verification_revision_fk' });

    await client`
      INSERT INTO question_admission_verification (
        id, revision_id, revision_digest, policy_id, generation, outcome, recorded_at
      ) VALUES ('v1', 'rev_a', 'sha256:rev_a', 'admission-policy@2026-09-24', 1, 'passed', now())
    `;
    const rows = await client<{ revision_id: string; outcome: string; generation: number }[]>`
      SELECT revision_id, outcome, generation FROM question_admission_verification WHERE id = 'v1'
    `;
    expect(rows[0]).toMatchObject({ revision_id: 'rev_a', outcome: 'passed', generation: 1 });

    // P2-C：分支完整性 —— admitted 必须有 decided_at+evidence；withheld 必须有 reason。
    await expect(client`
      INSERT INTO question_group_lifecycle (
        group_id, availability, scoring_admission_state, claim_policy, created_at, updated_at
      ) VALUES ('grp_adm_bad', 'general_pool', 'admitted', 'unbounded', now(), now())
    `).rejects.toMatchObject({ constraint_name: 'question_group_lifecycle_admission_branch_ck' });
    await expect(client`
      INSERT INTO question_group_lifecycle (
        group_id, availability, scoring_admission_state, claim_policy, created_at, updated_at
      ) VALUES ('grp_adm_bad', 'general_pool', 'withheld', 'unbounded', now(), now())
    `).rejects.toMatchObject({ constraint_name: 'question_group_lifecycle_admission_branch_ck' });
    await client`
      INSERT INTO question_group_lifecycle (
        group_id, availability, scoring_admission_state,
        scoring_admission_withheld_reason, claim_policy, created_at, updated_at
      ) VALUES ('grp_w', 'container_only', 'withheld', 'unverified_rules', 'one_time', now(), now())
    `;
    await client`
      INSERT INTO question_group_lifecycle (
        group_id, current_revision_id, availability, scoring_admission_state,
        scoring_admission_evidence, scoring_admission_decided_at,
        scoring_admission_generation, claim_policy, created_at, updated_at
      ) VALUES (
        'grp_smoke', 'rev_a', 'general_pool', 'admitted',
        '{}'::jsonb, now(), 1, 'unbounded', now(), now()
      )
    `;
    // draft_status 语义拆分维度落位：挂起 ≠ 撤回，独立列。
    const lifecycle = await client<
      {
        suspended: boolean;
        suspension_reason: string | null;
        withdrawn: boolean;
        withdrawn_at: Date | null;
      }[]
    >`
      SELECT suspended, suspension_reason, withdrawn, withdrawn_at
      FROM question_group_lifecycle WHERE group_id = 'grp_smoke'
    `;
    expect(lifecycle[0]).toMatchObject({
      suspended: false,
      suspension_reason: null,
      withdrawn: false,
      withdrawn_at: null,
    });
    await expect(client`
      UPDATE question_group_lifecycle SET suspension_reason = 'mood' WHERE group_id = 'grp_smoke'
    `).rejects.toMatchObject({ constraint_name: 'question_group_lifecycle_suspension_reason_ck' });
  });
});

describe('migration smoke — YUK-1097 assessment truth guards', () => {
  // 0111 在 0105/0107 guard 先例上补三条 P1：
  //  (1) evaluation_group.submission_ids 成为成员关系的 DB 层派生缓存
  //      （submission INSERT trigger 追加 + 组行只许严格追加真实成员 +
  //      DELETE 拒绝）；
  //  (2) assessment_identity_mapping 身份坐标/裁决字段冻结（可变：
  //      is_current/supersedes_mapping_id 与 pending 行的注释刷新）；
  //  (3) evaluation 终态冻结（pending→completed 是唯一载荷写入迁移）。
  const FINAL_TAG = '0111_yuk1097_assessment_truth_guards';
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;

  beforeAll(async () => {
    ensureDockerHost();
    container = await migrationContainer().start();
    client = postgres(container.getConnectionUri(), { max: 1 });
    for (const migration of orderedMigrations()) {
      await applyMigrationFile(client, migration.sql);
      if (migration.tag === FINAL_TAG) break;
    }
    // 共享 fixture：revision → issuance → group+submission+head 链（FK 拓扑序）。
    await insertRevision('rev_97', 971);
    await insertIssuance('iss_97', 'rev_97');
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  async function insertRevision(
    revisionId: string,
    ordinal: number,
    groupId = 'grp_97',
  ): Promise<void> {
    await client`
      INSERT INTO question_revision (
        revision_id, group_id, revision_ordinal, integrity_digest,
        structure, response_spec, scoring_basis, execution_plan,
        availability, published_at
      ) VALUES (
        ${revisionId}, ${groupId}, ${ordinal}, ${`sha256:${revisionId}`},
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        'general_pool', now()
      )
    `;
  }

  async function insertIssuance(issuanceId: string, revisionId: string): Promise<void> {
    await client`
      INSERT INTO assessment_issuance (
        issuance_id, revision_id, part_ids, material_bindings, option_order,
        container_occurrence_ref, claim_policy, claim_status, issued_at
      ) VALUES (
        ${issuanceId}, ${revisionId}, '["p1"]'::jsonb, '[]'::jsonb, '[]'::jsonb,
        null, 'unbounded', 'unclaimed', now()
      )
    `;
  }

  async function insertGroup(groupId: string, declared: string[]): Promise<void> {
    await client`
      INSERT INTO evaluation_group (evaluation_group_id, submission_ids, created_at)
      VALUES (${groupId}, ${client.json(declared)}::jsonb, now())
    `;
  }

  async function insertSubmission(
    submissionId: string,
    groupId: string,
    idempotencyKey: string,
  ): Promise<void> {
    await client`
      INSERT INTO assessment_submission (
        submission_id, issuance_id, revision_id, evaluation_group_id,
        response_set, idempotency_key, submitted_at
      ) VALUES (
        ${submissionId}, 'iss_97', 'rev_97', ${groupId},
        '{}'::jsonb, ${idempotencyKey}, now()
      )
    `;
  }

  async function readGroupIds(groupId: string): Promise<string[]> {
    const [row] = await client<{ submission_ids: string[] }[]>`
      SELECT submission_ids FROM evaluation_group WHERE evaluation_group_id = ${groupId}
    `;
    if (row === undefined) throw new Error(`fixture group ${groupId} not found`);
    return row.submission_ids;
  }

  async function insertMapping(
    mappingId: string,
    status: string,
    opts: { locator?: string; targetRevision?: string } = {},
  ): Promise<void> {
    await client`
      INSERT INTO assessment_identity_mapping (
        mapping_id, source_kind, source_id, source_locator,
        original_question_id, target_revision_id, algorithm_version, status,
        is_current, created_at
      ) VALUES (
        ${mappingId}, 'paper_answer', '97', ${opts.locator ?? `paper.slots[${mappingId}]`},
        'q97', ${opts.targetRevision ?? null}, 'map-v1', ${status}, true, now()
      )
    `;
  }

  // ── (1) evaluation_group.submission_ids 派生缓存 ──

  it('submission INSERT appends to the group array; declare-first is allowed, divergence is impossible on UPDATE', async () => {
    await insertGroup('eg_97a', ['sub_97a']);
    await insertSubmission('sub_97a', 'eg_97a', 'idem-97a');
    // INSERT 时已声明自身 ⇒ trigger 追加是 no-op，不重复。
    expect(await readGroupIds('eg_97a')).toEqual(['sub_97a']);

    // declare-first：组行可声明尚不存在的成员（计划模式），兑现由 trigger 补齐。
    await insertGroup('eg_97b', ['sub_97b1', 'sub_97b2']);
    await insertSubmission('sub_97b1', 'eg_97b', 'idem-97b1');
    expect(await readGroupIds('eg_97b')).toEqual(['sub_97b1', 'sub_97b2']);
    // 未声明成员的 submission 落库 ⇒ trigger 追加到数组尾。
    await insertGroup('eg_97c', ['sub_97c1']);
    await insertSubmission('sub_97c1', 'eg_97c', 'idem-97c1');
    await insertSubmission('sub_97c2', 'eg_97c', 'idem-97c2');
    expect(await readGroupIds('eg_97c')).toEqual(['sub_97c1', 'sub_97c2']);
  });

  it('group UPDATE is append-only real members: removal, reorder, phantom, dup tail all rejected', async () => {
    await insertGroup('eg_97d', ['sub_97d1', 'sub_97d2']);
    await insertSubmission('sub_97d1', 'eg_97d', 'idem-97d1');
    await insertSubmission('sub_97d2', 'eg_97d', 'idem-97d2');

    // 移除成员 ⇒ P0001。
    await expect(client`
      UPDATE evaluation_group SET submission_ids = '["sub_97d1"]'::jsonb
      WHERE evaluation_group_id = 'eg_97d'
    `).rejects.toMatchObject({ code: 'P0001' });
    // 保元素但重排 ⇒ P0001（严格前缀追加）。
    await expect(client`
      UPDATE evaluation_group SET submission_ids = '["sub_97d2","sub_97d1","sub_97d3"]'::jsonb
      WHERE evaluation_group_id = 'eg_97d'
    `).rejects.toMatchObject({ code: 'P0001' });
    // 追加不存在的成员 ⇒ P0001（幻影 id）。
    await expect(client`
      UPDATE evaluation_group SET submission_ids = '["sub_97d1","sub_97d2","sub_ghost"]'::jsonb
      WHERE evaluation_group_id = 'eg_97d'
    `).rejects.toMatchObject({ code: 'P0001' });
    // 追加他组真实成员 ⇒ P0001（成员资格按 evaluation_group_id 判定）。
    await insertGroup('eg_97e', ['sub_97e']);
    await insertSubmission('sub_97e', 'eg_97e', 'idem-97e');
    await expect(client`
      UPDATE evaluation_group SET submission_ids = '["sub_97d1","sub_97d2","sub_97e"]'::jsonb
      WHERE evaluation_group_id = 'eg_97d'
    `).rejects.toMatchObject({ code: 'P0001' });
    // 追加段重复自身 ⇒ P0001。
    await expect(client`
      UPDATE evaluation_group SET submission_ids = '["sub_97d1","sub_97d2","sub_97d1"]'::jsonb
      WHERE evaluation_group_id = 'eg_97d'
    `).rejects.toMatchObject({ code: 'P0001' });
    // 追加本组真实成员 ⇒ 放行（合规手动补齐路径）。
    await client`
      INSERT INTO assessment_submission (
        submission_id, issuance_id, revision_id, evaluation_group_id,
        response_set, idempotency_key, submitted_at
      ) VALUES ('sub_97d3', 'iss_97', 'rev_97', 'eg_97d', '{}'::jsonb, 'idem-97d3', now())
    `;
    // trigger 已把 sub_97d3 追加 ⇒ 手动同值/重复追加是合法 no-op。
    expect(await readGroupIds('eg_97d')).toEqual(['sub_97d1', 'sub_97d2', 'sub_97d3']);
    // 身份坐标冻结：created_at 改写拒绝（悬空组无 FK 兜底，同态 PK 改写同理）。
    await expect(client`
      UPDATE evaluation_group SET created_at = now() + interval '1 day'
      WHERE evaluation_group_id = 'eg_97d'
    `).rejects.toMatchObject({ code: 'P0001' });
    // 同值 UPDATE（IS NOT DISTINCT 语义）不受影响。
    await client`
      UPDATE evaluation_group SET submission_ids = submission_ids
      WHERE evaluation_group_id = 'eg_97d'
    `;
    // DELETE 一律拒绝（组行不可抹除）。
    await expect(client`
      DELETE FROM evaluation_group WHERE evaluation_group_id = 'eg_97d'
    `).rejects.toMatchObject({ code: 'P0001' });
    // restore 通道：GUC 事务内可 wipe —— 先子后父（archive.ts 反序），
    // FK 本身不受 guard GUC 影响。
    await client.begin(async (tx) => {
      await tx`SET LOCAL app.assessment_restore_mode = 'on'`;
      await tx`DELETE FROM assessment_submission WHERE submission_id = 'sub_97e'`;
      await tx`DELETE FROM evaluation_group WHERE evaluation_group_id = 'eg_97e'`;
    });
    const gone = await client`
      SELECT 1 FROM evaluation_group WHERE evaluation_group_id = 'eg_97e'
    `;
    expect(gone).toHaveLength(0);
  });

  // ── (2) assessment_identity_mapping 冻结 ──

  it('identity mapping: adjudication fields frozen; only is_current/supersedes mutable + pending annotation refresh', async () => {
    await insertMapping('map_97_pending', 'pending');
    // pending 占位行：evidence/algorithm_version 操作性注释刷新放行（P1-5）。
    await client`
      UPDATE assessment_identity_mapping
      SET evidence = '{"note":"retry"}'::jsonb, algorithm_version = 'yuk1050-apply/r2'
      WHERE mapping_id = 'map_97_pending'
    `;
    // pending 行的裁决字段仍冻结（status 改写只能走 supersedes 新行）。
    await expect(client`
      UPDATE assessment_identity_mapping SET status = 'mapped'
      WHERE mapping_id = 'map_97_pending'
    `).rejects.toMatchObject({ code: 'P0001' });

    await insertMapping('map_97_mapped', 'mapped', {
      locator: 'paper.slots[m97m]',
      targetRevision: 'rev_97',
    });
    // 已裁决行：注释也冻结。
    await expect(client`
      UPDATE assessment_identity_mapping SET evidence = '{"tamper":true}'::jsonb
      WHERE mapping_id = 'map_97_mapped'
    `).rejects.toMatchObject({ code: 'P0001' });
    // 身份坐标逐列冻结（抽样三类：定位/目标坐标/时点）。
    await expect(client`
      UPDATE assessment_identity_mapping SET source_locator = 'paper.slots[other]'
      WHERE mapping_id = 'map_97_mapped'
    `).rejects.toMatchObject({ code: 'P0001' });
    await expect(client`
      UPDATE assessment_identity_mapping SET target_revision_id = NULL
      WHERE mapping_id = 'map_97_mapped'
    `).rejects.toMatchObject({ code: 'P0001' });
    await expect(client`
      UPDATE assessment_identity_mapping SET created_at = now() + interval '1 day'
      WHERE mapping_id = 'map_97_mapped'
    `).rejects.toMatchObject({ code: 'P0001' });
    // 修正链可变列放行：is_current 翻转 + supersedes 链写入。
    await client`
      UPDATE assessment_identity_mapping
      SET is_current = false, supersedes_mapping_id = 'map_97_pending'
      WHERE mapping_id = 'map_97_mapped'
    `;
    const [flipped] = await client<{ is_current: boolean; supersedes_mapping_id: string | null }[]>`
      SELECT is_current, supersedes_mapping_id FROM assessment_identity_mapping
      WHERE mapping_id = 'map_97_mapped'
    `;
    expect(flipped).toMatchObject({ is_current: false, supersedes_mapping_id: 'map_97_pending' });
    // DELETE 一律拒绝 —— 历史裁决不可抹除。
    await expect(client`
      DELETE FROM assessment_identity_mapping WHERE mapping_id = 'map_97_mapped'
    `).rejects.toMatchObject({ code: 'P0001' });
    // restore 通道放行（模拟 archive.ts 恢复事务的修正擦写）。
    await client.begin(async (tx) => {
      await tx`SET LOCAL app.assessment_restore_mode = 'on'`;
      await tx`
        UPDATE assessment_identity_mapping SET evidence = '{"restored":true}'::jsonb
        WHERE mapping_id = 'map_97_mapped'
      `;
    });
  });

  // ── (3) evaluation 终态冻结 ──

  it('evaluation: payload writable only via pending→completed; terminal row is frozen; DELETE rejected', async () => {
    await insertGroup('eg_97f', ['sub_97f']);
    await insertSubmission('sub_97f', 'eg_97f', 'idem-97f');

    // pending 行插入（最小载荷）。
    await client`
      INSERT INTO evaluation (
        evaluation_id, evaluation_group_id, submission_id, attempt, status, created_at
      ) VALUES ('ev_97p', 'eg_97f', 'sub_97f', 1, 'pending', now())
    `;
    // pending→pending：run_refs 操作性补充放行。
    await client`
      UPDATE evaluation SET run_refs = '["run_1"]'::jsonb
      WHERE evaluation_id = 'ev_97p'
    `;
    // pending→pending 的载荷改写拒绝（unit_results/aggregate/plan_digest/provenance）。
    await expect(client`
      UPDATE evaluation SET aggregate = '{"verdict":"x"}'::jsonb
      WHERE evaluation_id = 'ev_97p'
    `).rejects.toMatchObject({ code: 'P0001' });
    await expect(client`
      UPDATE evaluation SET plan_digest = 'dg_tampered'
      WHERE evaluation_id = 'ev_97p'
    `).rejects.toMatchObject({ code: 'P0001' });
    // pending 行身份坐标也冻结。
    await expect(client`
      UPDATE evaluation SET attempt = 2 WHERE evaluation_id = 'ev_97p'
    `).rejects.toMatchObject({ code: 'P0001' });
    // pending→completed 是唯一携带终态载荷的合法迁移。
    await client`
      UPDATE evaluation
      SET status = 'completed',
          unit_results = '[{"u":1,"score":1}]'::jsonb,
          aggregate = '{"score":1}'::jsonb,
          plan_digest = 'dg_final',
          provenance = '{"source":"automatic"}'::jsonb
      WHERE evaluation_id = 'ev_97p'
    `;
    // 终态后：status/载荷/run_refs 任何改写拒绝。
    await expect(client`
      UPDATE evaluation SET unit_results = '[]'::jsonb WHERE evaluation_id = 'ev_97p'
    `).rejects.toMatchObject({ code: 'P0001' });
    await expect(client`
      UPDATE evaluation SET run_refs = '["run_2"]'::jsonb WHERE evaluation_id = 'ev_97p'
    `).rejects.toMatchObject({ code: 'P0001' });
    await expect(client`
      UPDATE evaluation SET status = 'pending' WHERE evaluation_id = 'ev_97p'
    `).rejects.toMatchObject({ code: 'P0001' });
    // 终态行同值 UPDATE（IS NOT DISTINCT）不受影响。
    await client`
      UPDATE evaluation SET aggregate = '{"score":1}'::jsonb WHERE evaluation_id = 'ev_97p'
    `;
    // DELETE 一律拒绝 —— 判分尝试记录不可抹除。
    await expect(client`
      DELETE FROM evaluation WHERE evaluation_id = 'ev_97p'
    `).rejects.toMatchObject({ code: 'P0001' });
    // restore 通道放行。
    await client.begin(async (tx) => {
      await tx`SET LOCAL app.assessment_restore_mode = 'on'`;
      await tx`
        UPDATE evaluation SET run_refs = '["run_restored"]'::jsonb
        WHERE evaluation_id = 'ev_97p'
      `;
    });
    const [restored] = await client<{ run_refs: string[] }[]>`
      SELECT run_refs FROM evaluation WHERE evaluation_id = 'ev_97p'
    `;
    expect(restored?.run_refs).toEqual(['run_restored']);
  });
});

for (const populated of [false, true])
  describe(`migration smoke — YUK-1394 ${populated ? 'populated post-1393' : 'empty post-1393'} ledger`, () => {
    let container: StartedPostgreSqlContainer;
    let client: ReturnType<typeof postgres>;
    let before: unknown;
    beforeAll(async () => {
      ensureDockerHost();
      container = await migrationContainer().start();
      client = postgres(container.getConnectionUri(), { max: 1 });
      const migrations = orderedMigrations();
      expect(
        migrations.some((migration) => migration.tag === '0117_yuk1394_session_orphan_backend'),
      ).toBe(true);
      for (const migration of migrations) {
        if (migration.tag === '0117_yuk1394_session_orphan_backend') break;
        await applyMigrationFile(client, migration.sql);
      }
      if (populated) {
        await client`insert into learning_session (id,type,status,started_at,version,summary_md,warnings) values ('migration-conversation','conversation','idle','2026-01-01T00:00:00.123456Z',33,${'保留原始记录\n'.repeat(300)},'[]'), ('migration-placement','placement','started','2026-01-01T00:00:00.654321Z',19,'placement summary','[]')`;
        await client`insert into prune_job_events_receipt (workflow_id,cutoff,deleted) values ('old-prune','2026-01-01T00:00:00Z',17)`;
        await client`insert into review_orphan_tick (tick_id,backend,provenance,tick_at,cutoff,admission,candidates,contract_version) values ('legacy:00000000-0000-4000-8000-000000000001','pg-boss','legacy-first-admission','2026-10-09T00:00:00Z','2026-10-08T18:00:00Z','admitted','[{"sessionId":"missing-history","selectedStartedAt":"2026-10-08T12:00:00Z","selectedVersion":4}]',1)`;
        await client`insert into review_orphan_receipt (tick_id,session_id,outcome) values ('legacy:00000000-0000-4000-8000-000000000001','missing-history','{"kind":"skipped","reason":"missing"}')`;
      }
      before = await snapshot();
      const migration = migrations.find((m) => m.tag === '0117_yuk1394_session_orphan_backend');
      if (!migration) throw new Error('Reserved migration missing');
      await applyMigrationFile(client, migration.sql);
    }, 120000);
    async function snapshot() {
      const output: Record<string, unknown> = {};
      for (const table of [
        'learning_session',
        'prune_job_events_control',
        'prune_job_events_receipt',
        'prune_job_events_disposition',
        'review_orphan_control',
        'review_orphan_tick',
        'review_orphan_receipt',
        'review_orphan_disposition',
      ])
        output[table] = await client.unsafe(
          `select to_jsonb(t) as row from "${table}" t order by to_jsonb(t)::text`,
        );
      return output;
    }
    afterAll(async () => {
      await client?.end();
      await container?.stop();
    });
    it('preserves domain and predecessor ledger bytes, seeds exactly two independent legacy owners', async () => {
      expect(await snapshot()).toEqual(before);
      expect(await client`select family,phase from session_orphan_control order by family`).toEqual(
        [
          { family: 'prune_orphan_conversation_sessions', phase: 'pg-boss' },
          { family: 'prune_orphan_placement_sessions', phase: 'pg-boss' },
        ],
      );
    });
    it('enforces exact-family composite identity, concrete dispositions and immutable evidence', async () => {
      const family = 'prune_orphan_conversation_sessions';
      const tick = 'legacy:00000000-0000-4000-8000-000000000002';
      await expect(
        client`insert into session_orphan_control (family,phase) values ('unknown','pg-boss')`,
      ).rejects.toThrow();
      await client`insert into session_orphan_tick (family,tick_id,backend,provenance,tick_at,cutoff,admission,candidates,contract_version) values (${family},${tick},'pg-boss','legacy-first-admission','2026-10-09T00:00:00Z','2026-10-08T18:00:00Z','admitted','[{"sessionId":"missing","selectedStartedAt":"2026-10-08T12:00:00Z","selectedVersion":0}]',1)`;
      await expect(
        client`insert into session_orphan_receipt (family,tick_id,session_id,outcome) values ('prune_orphan_placement_sessions',${tick},'missing','{"kind":"skipped","reason":"missing"}')`,
      ).rejects.toThrow();
      await client`insert into session_orphan_receipt (family,tick_id,session_id,outcome) values (${family},${tick},'missing','{"kind":"skipped","reason":"missing"}')`;
      await expect(
        client`insert into session_orphan_disposition (family,id,backend,kind,observed_state,reason) values (${family},'bad','pg-boss','terminal-task','failed','missing target')`,
      ).rejects.toThrow();
      await client`insert into session_orphan_disposition (family,id,backend,kind,observed_state,reason,barrier_at) values (${family},'proof','pg-boss','quiescence','draining-pg-boss','test evidence','2026-10-09T00:00:00.000001Z')`;
      for (const table of [
        'session_orphan_tick',
        'session_orphan_receipt',
        'session_orphan_disposition',
      ]) {
        await expect(client.unsafe(`delete from ${table}`)).rejects.toThrow('immutable');
        await expect(client.unsafe(`update ${table} set family = family`)).rejects.toThrow(
          'immutable',
        );
      }
    });
  });
