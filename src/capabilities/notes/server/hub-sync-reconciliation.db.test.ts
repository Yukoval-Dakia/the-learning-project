// YUK-384 Task 2 — trigger-backed durable dirty generations (RED Tests 2–6).
//
// These adversarial DB tests validate the PostgreSQL topology triggers installed
// by drizzle/0071 (mark_hub_sync_dirty + fanout_hub_sync_dirty): dirtying is
// commit-atomic (rollback/savepoint safe), topology-selective (embedding /
// verification_summary / non-topology columns never dirty), fans out to every
// live hub on atomic/knowledge/edge topology transitions, dirties or cancels a
// single hub on hub-local changes, never self-dirties under the internal-apply
// marker, and locks hubs in sorted artifact-id order without deadlock.

import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { beforeEach, describe, expect, it } from 'vitest';

import { artifact, knowledge, knowledge_edge } from '@/db/schema';

import { resetDb, testDb } from '../../../../tests/helpers/db';

const NOW = new Date('2026-07-21T00:00:00Z');

// Raw postgres client for explicit-transaction primitives (savepoints,
// per-statement statement_timeout, true concurrency) that drizzle's pooled
// helper does not expose. Same TEST_DATABASE_URL → same per-worker fork DB.
let _raw: ReturnType<typeof postgres> | undefined;
function rawClient(): ReturnType<typeof postgres> {
  if (_raw) return _raw;
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL not set — globalSetup did not run');
  _raw = postgres(url, { max: 4 });
  return _raw;
}

async function seedKnowledge(id: string, opts: { domain?: string } = {}) {
  await testDb()
    .insert(knowledge)
    .values({
      id,
      name: id,
      domain: opts.domain ?? 'yuwen',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: NOW,
      updated_at: NOW,
      version: 0,
    });
}

async function seedArtifact(opts: {
  id: string;
  type: 'note_hub' | 'note_atomic';
  knowledgeIds: string[];
  title?: string;
}) {
  await testDb()
    .insert(artifact)
    .values({
      id: opts.id,
      type: opts.type,
      title: opts.title ?? opts.id,
      parent_artifact_id: null,
      knowledge_ids: opts.knowledgeIds,
      intent_source: 'learning_intent',
      source: 'ai_generated',
      source_ref: null,
      body_blocks: { type: 'doc', content: [] } as never,
      attrs: {} as never,
      tool_kind: null,
      tool_state: null,
      generation_status: 'ready',
      verification_status: 'verified',
      verification_summary: null,
      generated_by: null,
      verified_by: null,
      history: [],
      archived_at: null,
      created_at: NOW,
      updated_at: NOW,
      version: 0,
    });
}

async function seedEdge(id: string, from: string, to: string, relation: string) {
  await testDb()
    .insert(knowledge_edge)
    .values({
      id,
      from_knowledge_id: from,
      to_knowledge_id: to,
      relation_type: relation,
      weight: 1,
      created_by: 'user' as never,
      reasoning: null,
      created_at: NOW,
    });
}

async function seedHub(id: string, knowledgeIds: string[] = ['k1']) {
  await seedArtifact({ id, type: 'note_hub', knowledgeIds });
}

async function generation(id: string): Promise<string> {
  const rows = await testDb().execute<{ generation: string }>(sql`
    select generation::text as generation
    from hub_sync_reconciliation where artifact_id = ${id}
  `);
  return rows[0]?.generation;
}

// Reads through a distinct pooled connection, so a query issued while a
// db.transaction() is open observes only committed state.
async function generationOutsideTransaction(id: string): Promise<string> {
  return generation(id);
}

async function generations(ids: string[]): Promise<bigint[]> {
  return Promise.all(ids.map(async (id) => BigInt(await generation(id))));
}

async function state(id: string): Promise<{
  generation: string;
  acknowledged_generation: string;
  status: string;
  consecutive_failure_count: number;
}> {
  const rows = await testDb().execute<{
    generation: string;
    acknowledged_generation: string;
    status: string;
    consecutive_failure_count: number;
  }>(sql`
    select generation::text as generation,
           acknowledged_generation::text as acknowledged_generation,
           status,
           consecutive_failure_count
    from hub_sync_reconciliation where artifact_id = ${id}
  `);
  return rows[0];
}

async function expectGenerationDelta(
  id: string,
  delta: number,
  mutate: () => Promise<unknown>,
): Promise<void> {
  const before = BigInt(await generation(id));
  await mutate();
  const after = BigInt(await generation(id));
  expect(after - before).toBe(BigInt(delta));
}

// Runs `run` inside its own transaction with a bounded per-statement timeout, so
// a lock-order deadlock would abort (reject) instead of hanging the suite.
async function withStatementTimeout<T>(
  ms: number,
  run: (c: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return rawClient().begin(async (c) => {
    await c.unsafe(`SET LOCAL statement_timeout = ${ms}`);
    return run(c as postgres.TransactionSql);
  }) as Promise<T>;
}

describe('YUK-384 durable hub-sync topology triggers', () => {
  beforeEach(async () => {
    await resetDb();
    // Seed KG entities BEFORE any hub so their INSERT fan-outs touch zero hubs;
    // hub-a is then created last and lands at generation 1 with a clean cursor.
    await seedKnowledge('k1');
    await seedKnowledge('k2');
    await seedArtifact({ id: 'atomic-a', type: 'note_atomic', knowledgeIds: ['k1'] });
    await seedEdge('e1', 'k1', 'k2', 'prerequisite');
    await seedHub('hub-a', ['k1']);
  });

  it('YUK-384 RED 02: dirty generation follows outer commit, rollback, and savepoint rollback', async () => {
    const db = testDb();

    await db.transaction(async (tx) => {
      await tx.update(knowledge).set({ name: 'committed' }).where(eq(knowledge.id, 'k1'));
      // Uncommitted dirty is invisible on a separate connection.
      expect(await generationOutsideTransaction('hub-a')).toBe('1');
    });
    expect(await generation('hub-a')).toBe('2');

    await expect(
      db.transaction(async (tx) => {
        await tx.update(knowledge).set({ name: 'rolled-back' }).where(eq(knowledge.id, 'k1'));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await generation('hub-a')).toBe('2');

    // Savepoint rollback undoes the write AND its trigger's generation bump.
    await rawClient().begin(async (c) => {
      await c`savepoint dirty_sp`;
      await c`update knowledge set name = 'savepoint' where id = 'k1'`;
      await c`rollback to savepoint dirty_sp`;
    });
    expect(await generation('hub-a')).toBe('2');
  });

  it('YUK-384 RED 03: only topology columns dirty hubs', async () => {
    await expectGenerationDelta('hub-a', 0, () =>
      testDb().execute(sql`update knowledge set embedding = null where id = 'k1'`),
    );
    await expectGenerationDelta('hub-a', 1, () =>
      testDb().execute(sql`update knowledge set name = 'renamed' where id = 'k1'`),
    );
    await expectGenerationDelta('hub-a', 0, () =>
      testDb().execute(
        sql`update artifact set verification_summary = '{}'::jsonb where id = 'atomic-a'`,
      ),
    );
    await expectGenerationDelta('hub-a', 1, () =>
      testDb().execute(sql`update artifact set title = 'renamed' where id = 'atomic-a'`),
    );
  });

  it('YUK-384 RED 04: every atomic topology transition dirties all live hubs', async () => {
    await seedHub('hub-b', ['k2']);

    // Each closure performs exactly one atomic topology transition and must
    // dirty EVERY live hub by exactly one generation. Ordering keeps atomic-a a
    // live note_atomic until the terminal `type` change.
    const atomicTopologyMutations: Array<() => Promise<unknown>> = [
      () => testDb().execute(sql`update artifact set title = 'retitled' where id = 'atomic-a'`),
      () =>
        testDb().execute(
          sql`update artifact set knowledge_ids = '["k2"]'::jsonb where id = 'atomic-a'`,
        ),
      () =>
        testDb().execute(
          sql`update artifact set archived_at = clock_timestamp() where id = 'atomic-a'`,
        ),
      () => testDb().execute(sql`update artifact set archived_at = null where id = 'atomic-a'`),
      () => seedArtifact({ id: 'atomic-c', type: 'note_atomic', knowledgeIds: ['k1'] }),
      () => testDb().execute(sql`delete from artifact where id = 'atomic-c'`),
      () => testDb().execute(sql`update artifact set type = 'note' where id = 'atomic-a'`),
    ];

    for (const mutate of atomicTopologyMutations) {
      const before = await generations(['hub-a', 'hub-b']);
      await mutate();
      expect(await generations(['hub-a', 'hub-b'])).toEqual(before.map((value) => value + 1n));
    }
  });

  it('YUK-384 RED 05: hub-local changes dirty or cancel one hub and internal apply does not self-dirty', async () => {
    await seedHub('hub-b', ['k2']);

    // Real suppression attr is attrs.suppressed_block_refs[] (see
    // src/capabilities/notes/api/hub-dismiss-link.ts), NOT hub_mesh_suppressed_ids.
    await testDb().execute(sql`
      update artifact
      set attrs = jsonb_set(attrs, '{suppressed_block_refs}', '[{"artifact_id":"atomic-a"}]'::jsonb)
      where id = 'hub-a'
    `);
    expect(await state('hub-a')).toMatchObject({ generation: '2', status: 'pending' });

    await testDb().execute(
      sql`update artifact set archived_at = clock_timestamp() where id = 'hub-a'`,
    );
    expect(await state('hub-a')).toMatchObject({ generation: '3', status: 'cancelled' });

    // The reconciler-owned body write sets the internal marker and must not
    // self-dirty, even though body_blocks genuinely changes.
    await testDb().transaction(async (tx) => {
      await tx.execute(sql`set local app.hub_sync_internal_apply = '1'`);
      await tx.execute(sql`
        update artifact
        set body_blocks = '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb
        where id = 'hub-b'
      `);
    });
    expect(await generation('hub-b')).toBe('1');
  });

  it('YUK-384 RED 06: concurrent global fan-out locks hubs in artifact-id order', async () => {
    await seedHub('hub-z', ['k2']);

    // knowledge.name (topology) and knowledge_edge.archived_at (topology per the
    // edge-selectivity spec: endpoint/relation/archive) each fan out to every
    // live hub. Sorted-artifact-id lock acquisition keeps them deadlock-free.
    const [left, right] = await Promise.allSettled([
      withStatementTimeout(
        2_000,
        (c) => c`update knowledge set name = name || '-a' where id = 'k1'`,
      ),
      withStatementTimeout(
        2_000,
        (c) => c`update knowledge_edge set archived_at = clock_timestamp() where id = 'e1'`,
      ),
    ]);
    expect([left.status, right.status]).toEqual(['fulfilled', 'fulfilled']);
    expect(await generations(['hub-a', 'hub-z'])).toEqual([3n, 3n]);
  });
});
