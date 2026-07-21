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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildHubSyncRecoveryHandler } from '@/capabilities/notes/jobs/hub_auto_sync_nightly';
import { readHubSyncHealth } from '@/capabilities/observability/server/hub-sync';
import { artifact, knowledge, knowledge_edge } from '@/db/schema';
import { PgPresenceStore } from '@/server/artifacts/presence/pg';
import { sendHubSyncMutationWake } from '@/server/boss/hub-sync-wake';

import { NoteRefineApplyError } from '@/core/blocks/apply-note-patch';
import { gatherAndFoldArtifact } from '@/server/projections/gather';
import { backfillArtifactGenesis } from '../../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  type HubDesiredState,
  type HubSyncClaim,
  claimNextHubSync,
  classifyHubSyncError,
  computeHubDesiredState,
  finalizeHubSync,
  recordHubSyncRetry,
  renewHubSyncLease,
  repairHubSyncCoverage,
  runHubSyncCycle,
  sweepAbandonedEditSessions,
} from './hub-sync-reconciliation';

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
  last_error_class: string | null;
  last_error_code: string | null;
  last_outcome: string | null;
}> {
  const rows = await testDb().execute<{
    generation: string;
    acknowledged_generation: string;
    status: string;
    consecutive_failure_count: number;
    last_error_class: string | null;
    last_error_code: string | null;
    last_outcome: string | null;
  }>(sql`
    select generation::text as generation,
           acknowledged_generation::text as acknowledged_generation,
           status,
           consecutive_failure_count,
           last_error_class,
           last_error_code,
           last_outcome
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

// ── Task 3 (RED Tests 7–9): one-at-a-time claim + renewable lease ──────────────
// Deterministic time control: instead of sleeping on a real clock, lease/attempt
// stamps are moved directly. Ready hubs are seeded per-test (no shared beforeEach
// seed) so RED 07's exact claimed/pending counts hold.

async function seedReadyHubs(n: number): Promise<void> {
  for (let i = 1; i <= n; i += 1) {
    await seedHub(`ready-hub-${i}`, []);
  }
}

async function countByStatus(status: string): Promise<number> {
  const rows = await testDb().execute<{ count: string }>(sql`
    select count(*)::text as count from hub_sync_reconciliation where status = ${status}
  `);
  return Number(rows[0]?.count ?? '0');
}

async function claimRequired(owner: string): Promise<HubSyncClaim> {
  const claim = await claimNextHubSync(testDb(), { owner });
  if (!claim) throw new Error(`expected a claim for ${owner}`);
  return claim;
}

async function expireClaim(claim: HubSyncClaim): Promise<void> {
  await testDb().execute(sql`
    update hub_sync_reconciliation
    set lease_expires_at = clock_timestamp() - interval '1 second'
    where artifact_id = ${claim.artifactId}
  `);
}

// Models wall-clock passage by moving lease/next-attempt stamps earlier, so
// renewal-vs-expiry is deterministic (no real sleep).
async function advanceDatabaseClockBy(interval: string): Promise<void> {
  await testDb().execute(sql`
    update hub_sync_reconciliation
    set lease_expires_at = lease_expires_at - ${interval}::interval,
        next_attempt_at = next_attempt_at - ${interval}::interval
    where lease_expires_at is not null
  `);
}

// Mimics a fresh topology dirty landing on the claimed row (generation bump +
// claim reset), so the old token/generation no longer match.
async function supersedeClaim(claim: HubSyncClaim): Promise<void> {
  await testDb().execute(sql`
    update hub_sync_reconciliation
    set generation = generation + 1,
        status = 'pending',
        claim_owner = null,
        claim_token = null,
        lease_expires_at = null,
        next_attempt_at = clock_timestamp()
    where artifact_id = ${claim.artifactId}
  `);
}

// Apply / ack / fail (Task 4 finalization) are all token + generation + lease
// fenced writes. An old/superseded token must match zero rows for every one.
async function expectOldTokenOperations(
  claim: HubSyncClaim,
): Promise<{ apply: boolean; ack: boolean; fail: boolean }> {
  const fenced = async (nextStatus: string): Promise<boolean> => {
    const rows = await testDb().execute<{ artifact_id: string }>(sql`
      update hub_sync_reconciliation
      set status = ${nextStatus}, updated_at = clock_timestamp()
      where artifact_id = ${claim.artifactId}
        and generation = ${claim.generation}::bigint
        and claim_token = ${claim.claimToken}
        and status in ('claimed', 'applying')
        and lease_expires_at >= clock_timestamp()
      returning artifact_id
    `);
    return rows.length === 1;
  };
  return {
    apply: await fenced('applying'),
    ack: await fenced('acknowledged'),
    fail: await fenced('retry_wait'),
  };
}

describe('YUK-384 hub-sync claim + renewable lease', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('YUK-384 RED 07: claims one generation once and does not lease a batch tail', async () => {
    await seedReadyHubs(3);
    const db = testDb();
    const [a, b] = await Promise.all([
      claimNextHubSync(db, { owner: 'worker-a' }),
      claimNextHubSync(db, { owner: 'worker-b' }),
    ]);
    expect(a?.artifactId).not.toBe(b?.artifactId);
    expect(await countByStatus('claimed')).toBe(2);
    expect(await countByStatus('pending')).toBe(1);
  });

  it('YUK-384 RED 08: expired claim is reclaimed and old token is powerless', async () => {
    await seedReadyHubs(1);
    const oldClaim = await claimRequired('worker-old');
    await expireClaim(oldClaim);
    const newClaim = await claimRequired('worker-new');
    expect(newClaim.claimToken).not.toBe(oldClaim.claimToken);
    await expect(expectOldTokenOperations(oldClaim)).resolves.toEqual({
      apply: false,
      ack: false,
      fail: false,
    });
  });

  it('YUK-384 RED 09: renewal extends long compute and zero-row renewal aborts it', async () => {
    await seedReadyHubs(1);
    const claim = await claimRequired('worker-a');
    await advanceDatabaseClockBy('90 seconds');
    expect(await renewHubSyncLease(testDb(), claim)).toBe(true);
    await supersedeClaim(claim);
    expect(await renewHubSyncLease(testDb(), claim)).toBe(false);
  });
});

// ── Task 4 (RED Tests 10–14): deterministic compute + atomic fenced apply ─────

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Pauses finalization at a named point so a competing mutation can race the
// held cursor lock (RED 11).
class FinalizeBarrier {
  private readonly reached = createDeferred();
  private readonly released = createDeferred();
  constructor(readonly at: string) {}
  async hit(): Promise<void> {
    this.reached.resolve();
    await this.released.promise;
  }
  waitUntilReached(): Promise<void> {
    return this.reached.promise;
  }
  release(): void {
    this.released.resolve();
  }
}

describe('YUK-384 hub-sync fenced apply', () => {
  let prepared: { claim: HubSyncClaim; desired: HubDesiredState };
  let snapshotBefore: Record<string, unknown>;

  beforeEach(async () => {
    await resetDb();
    // hub-a shares knowledge kc with a live atomic, so compute yields a real
    // auto-zone change (changed=true). Atomic seeded before the hub so its
    // fan-out touches zero hubs; hub-a lands at generation 1.
    await seedKnowledge('kc');
    await seedArtifact({
      id: 'atomic-a',
      type: 'note_atomic',
      knowledgeIds: ['kc'],
      title: 'Atomic A',
    });
    await seedHub('hub-a', ['kc']);
  });

  async function preparedClaim(): Promise<{ claim: HubSyncClaim; desired: HubDesiredState }> {
    const claim = await claimRequired('worker');
    const desired = await computeHubDesiredState(testDb(), claim);
    return { claim, desired };
  }

  async function finalizePrepared(p: {
    claim: HubSyncClaim;
    desired: HubDesiredState;
  }): Promise<string> {
    return finalizeHubSync(testDb(), { claim: p.claim, desired: p.desired, mode: 'apply' });
  }

  async function renameAtomic(id: string, title: string): Promise<void> {
    await testDb().execute(sql`update artifact set title = ${title} where id = ${id}`);
  }

  // Bumps artifact.version only (no topology column), so the cursor is NOT
  // re-dirtied — this exercises the artifact-version CAS defer path, not the
  // generation fence.
  async function ownerSaveHub(id: string): Promise<void> {
    await testDb().execute(
      sql`update artifact set version = version + 1, updated_at = clock_timestamp() where id = ${id}`,
    );
  }

  async function artifactVersionAndEventCount(
    id: string,
  ): Promise<{ version: number; events: number }> {
    const v = await testDb().execute<{ version: number }>(
      sql`select version from artifact where id = ${id}`,
    );
    const e = await testDb().execute<{ count: string }>(
      sql`select count(*)::text as count from event where subject_id = ${id}`,
    );
    return { version: v[0].version, events: Number(e[0].count) };
  }

  // Suppress the only matching atomic so desired is an empty (unchanged, VALID)
  // auto-zone. Touches attrs only — no artifact.version bump, no event — so the
  // caller's before/after counts stay equal across the no-op finalize.
  async function preparedNoopClaim(): Promise<{ claim: HubSyncClaim; desired: HubDesiredState }> {
    await testDb().execute(sql`
      update artifact
      set attrs = jsonb_set(coalesce(attrs, '{}'::jsonb), '{suppressed_block_refs}',
                            '[{"artifact_id":"atomic-a"}]'::jsonb)
      where id = 'hub-a'
    `);
    const claim = await claimRequired('worker');
    const desired = await computeHubDesiredState(testDb(), claim);
    return { claim, desired };
  }

  async function corruptHubDocument(id: string): Promise<void> {
    await testDb().execute(
      sql`update artifact set body_blocks = '{"not":"a valid doc"}'::jsonb where id = ${id}`,
    );
  }

  async function snapshotDurable(): Promise<Record<string, unknown>> {
    const a = await testDb().execute<{ version: number; body: string }>(
      sql`select version, body_blocks::text as body from artifact where id = 'hub-a'`,
    );
    const refs = await testDb().execute<{ count: string }>(
      sql`select count(*)::text as count from artifact_block_ref where from_artifact_id = 'hub-a'`,
    );
    const events = await testDb().execute<{ count: string }>(
      sql`select count(*)::text as count from event where subject_id = 'hub-a'`,
    );
    const cursor = await state('hub-a');
    return {
      version: a[0].version,
      body: a[0].body,
      refs: refs[0].count,
      events: events[0].count,
      generation: cursor.generation,
      acknowledged_generation: cursor.acknowledged_generation,
      status: cursor.status,
    };
  }

  // Re-establish a clean prepared claim for the next injected-failure iteration.
  async function resetPreparedHub(): Promise<void> {
    await testDb().execute(sql`
      update hub_sync_reconciliation
      set status = 'pending', claim_owner = null, claim_token = null, lease_expires_at = null,
          acknowledged_generation = 0, next_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
      where artifact_id = 'hub-a'
    `);
    await testDb().execute(
      sql`update artifact set body_blocks = '{"type":"doc","content":[]}'::jsonb where id = 'hub-a'`,
    );
    prepared = await preparedClaim();
    snapshotBefore = await snapshotDurable();
  }

  async function finalizeWithInjectedFailure(stage: string): Promise<string> {
    return finalizeHubSync(
      testDb(),
      { claim: prepared.claim, desired: prepared.desired, mode: 'apply' },
      {
        beforeStage: (s) => {
          if (s === stage) throw new Error(`inject:${stage}`);
        },
      },
    );
  }

  it('YUK-384 RED 10: N+1 committed before finalization fences N', async () => {
    const claimN = await claimRequired('worker');
    const desiredN = await computeHubDesiredState(testDb(), claimN);
    await renameAtomic('atomic-a', 'N+1');
    expect(
      await finalizeHubSync(testDb(), { claim: claimN, desired: desiredN, mode: 'apply' }),
    ).toBe('superseded');
    expect(await state('hub-a')).toMatchObject({
      generation: '2',
      acknowledged_generation: '0',
      status: 'pending',
    });
  });

  it('YUK-384 RED 11: N+1 waiting behind final cursor lock leaves newer pending state', async () => {
    const p = await preparedClaim();
    const barrier = new FinalizeBarrier('after-reconciliation-lock');
    const applyN = finalizeHubSync(
      testDb(),
      { claim: p.claim, desired: p.desired, mode: 'apply' },
      { afterCursorLock: () => barrier.hit() },
    );
    await barrier.waitUntilReached();
    const mutateN1 = renameAtomic('atomic-a', 'N+1');
    barrier.release();
    await Promise.all([applyN, mutateN1]);
    expect(await state('hub-a')).toMatchObject({
      generation: '2',
      acknowledged_generation: '1',
      status: 'pending',
    });
  });

  it('YUK-384 RED 12: artifact CAS conflict returns pending without failure', async () => {
    const p = await preparedClaim();
    await ownerSaveHub('hub-a');
    expect(await finalizePrepared(p)).toBe('superseded');
    expect(await state('hub-a')).toMatchObject({ status: 'pending', consecutive_failure_count: 0 });
  });

  it('YUK-384 RED 13: rollback at each apply stage leaves no partial effects', async () => {
    for (const stage of ['artifact', 'block_refs', 'event', 'ack'] as const) {
      await resetPreparedHub();
      await expect(finalizeWithInjectedFailure(stage)).rejects.toThrow(`inject:${stage}`);
      expect(await snapshotDurable()).toEqual(snapshotBefore);
    }
  });

  it('YUK-384 RED 14: valid no-op acknowledges without churn and invalid document retries', async () => {
    const before = await artifactVersionAndEventCount('hub-a');
    expect(await finalizePrepared(await preparedNoopClaim())).toBe('acknowledged_noop');
    expect(await artifactVersionAndEventCount('hub-a')).toEqual(before);

    await corruptHubDocument('hub-a');
    await runHubSyncCycle(testDb(), { reason: 'recovery', maxArtifacts: 1, mode: 'apply' });
    expect(await state('hub-a')).toMatchObject({
      status: 'retry_wait',
      last_error_class: 'invalid_document',
    });
  });

  it('YUK-384 (P2-a): a lease that expires mid-apply while holding the cursor lock still commits — no poison rollback', async () => {
    const prepared = await preparedClaim();
    // Shrink the lease so it expires DURING the artificially-delayed apply. finalize holds
    // the cursor row lock (exclusive — a concurrent reclaim would need the lock and would
    // change the token), so mid-transaction lease expiry is irrelevant: the apply must
    // COMMIT + ack, not roll back into a claim→long-apply→expire→rollback poison loop. The
    // background renewer can't help here (it is blocked on the same row lock), which is
    // exactly the reachable big-hub / slow-DB failure.
    await testDb().execute(
      sql`update hub_sync_reconciliation set lease_expires_at = clock_timestamp() + interval '200 milliseconds' where artifact_id = 'hub-a'`,
    );
    const before = await snapshotDurable();

    const outcome = await finalizeHubSync(
      testDb(),
      { claim: prepared.claim, desired: prepared.desired, mode: 'apply' },
      {
        beforeStage: async (stage) => {
          if (stage === 'artifact') await new Promise((resolve) => setTimeout(resolve, 500));
        },
      },
    );

    // Committed, not rolled back: applied outcome, body version bumped, cursor acked.
    expect(outcome).toBe('applied');
    const after = await snapshotDurable();
    expect(after.version).toBe((before.version as number) + 1);
    expect(await state('hub-a')).toMatchObject({ status: 'acknowledged', last_outcome: 'applied' });
  });
});

// ── Task 5 (RED Tests 16 & 18): session-qualified editing vs fenced apply ─────

describe('YUK-384 session-qualified editing defers fenced apply', () => {
  let store: PgPresenceStore;

  beforeEach(async () => {
    await resetDb();
    store = new PgPresenceStore(testDb());
    await seedKnowledge('kc');
    await seedArtifact({
      id: 'atomic-a',
      type: 'note_atomic',
      knowledgeIds: ['kc'],
      title: 'Atomic A',
    });
    await seedHub('hub-a', ['kc']);
  });

  async function preparedClaim(): Promise<{ claim: HubSyncClaim; desired: HubDesiredState }> {
    const claim = await claimRequired('worker');
    const desired = await computeHubDesiredState(testDb(), claim);
    return { claim, desired };
  }

  async function finalizePrepared(p: { claim: HubSyncClaim; desired: HubDesiredState }) {
    return finalizeHubSync(testDb(), { claim: p.claim, desired: p.desired, mode: 'apply' });
  }

  // Holds the per-artifact advisory lock in its own transaction until released,
  // so a heartbeat / finalize that takes the SAME lock must wait.
  async function holdHubAdvisoryLock(
    artifactId: string,
  ): Promise<{ release: () => void; done: Promise<unknown> }> {
    const held = createDeferred();
    const release = createDeferred();
    const done = rawClient().begin(async (c) => {
      await c`select pg_advisory_xact_lock(hashtextextended(${artifactId}, 0))`;
      held.resolve();
      await release.promise;
    });
    await held.promise;
    return { release: () => release.resolve(), done };
  }

  async function appliedWhileActive(artifactId: string): Promise<boolean> {
    return (await state(artifactId)).status === 'acknowledged';
  }

  async function heartbeatAtDatabaseAge(artifactId: string, sessionId: string, age: string) {
    await testDb().execute(sql`
      insert into artifact_edit_session (artifact_id, session_id, started_at, last_heartbeat_at)
      values (${artifactId}, ${sessionId}, clock_timestamp(), clock_timestamp() - ${age}::interval)
      on conflict (artifact_id, session_id)
      do update set last_heartbeat_at = clock_timestamp() - ${age}::interval
    `);
  }

  async function runOneApplyCycle() {
    return runHubSyncCycle(testDb(), { reason: 'recovery', maxArtifacts: 1, mode: 'apply' });
  }

  it('YUK-384 RED 16: first heartbeat and reconcile serialize an absent-row race', async () => {
    const prepared = await preparedClaim();
    // Both the heartbeat and finalize contend for the same advisory lock; the
    // holder forces the heartbeat to land first, so reconcile observes the
    // now-present session and defers instead of applying under an active editor.
    const barrier = await holdHubAdvisoryLock('hub-a');
    const heartbeat = store.recordEditingHeartbeat({ artifactId: 'hub-a', sessionId: 'A' });
    barrier.release();
    await barrier.done;
    await heartbeat;
    expect(await finalizePrepared(prepared)).toBe('deferred_editing');
    expect(await appliedWhileActive('hub-a')).toBe(false);
  });

  it('YUK-384 RED 18: active editing never increments failure count and missed blur expires into apply', async () => {
    await heartbeatAtDatabaseAge('hub-a', 'A', '5 seconds');
    await runOneApplyCycle();
    expect(await state('hub-a')).toMatchObject({ status: 'pending', consecutive_failure_count: 0 });

    await heartbeatAtDatabaseAge('hub-a', 'A', '31 seconds');
    // F2: the active-editor defer backs next_attempt_at off by 30s (avoids a tight reclaim
    // loop during editing). Simulate that window elapsing so the post-blur cycle re-claims —
    // in production the 30s simply passes.
    await testDb().execute(
      sql`update hub_sync_reconciliation set next_attempt_at = clock_timestamp() where artifact_id = 'hub-a'`,
    );
    await runOneApplyCycle();
    expect(await state('hub-a')).toMatchObject({
      status: 'acknowledged',
      consecutive_failure_count: 0,
    });
  });
});

// ── Task 7 (RED Tests 19–21): race closure across hub lifecycle ───────────────

describe('YUK-384 hub-sync lifecycle race closure', () => {
  beforeEach(async () => {
    await resetDb();
    await seedKnowledge('kc');
    await seedArtifact({
      id: 'atomic-a',
      type: 'note_atomic',
      knowledgeIds: ['kc'],
      title: 'Atomic A',
    });
    await seedHub('hub-a', ['kc']);
  });

  async function preparedClaim(): Promise<{ claim: HubSyncClaim; desired: HubDesiredState }> {
    const claim = await claimRequired('worker');
    const desired = await computeHubDesiredState(testDb(), claim);
    return { claim, desired };
  }

  function isDeadlock(err: unknown): boolean {
    const anyErr = err as
      | { message?: string; code?: string; cause?: { code?: string } }
      | undefined;
    return (
      anyErr?.code === '40P01' ||
      anyErr?.cause?.code === '40P01' ||
      /deadlock/i.test(String(anyErr?.message ?? err))
    );
  }

  const HUB_MUTATIONS: Record<string, (c: postgres.TransactionSql) => Promise<unknown>> = {
    archive: (c) => c`update artifact set archived_at = clock_timestamp() where id = 'hub-a'`,
    restore: async (c) => {
      await c`update artifact set archived_at = clock_timestamp() where id = 'hub-a'`;
      await c`update artifact set archived_at = null where id = 'hub-a'`;
    },
    suppression: (c) =>
      c`update artifact set attrs = jsonb_set(coalesce(attrs,'{}'::jsonb), '{suppressed_block_refs}', '[{"artifact_id":"atomic-a"}]'::jsonb) where id = 'hub-a'`,
    body_save: (c) =>
      c`update artifact set version = version + 1, body_blocks = '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb where id = 'hub-a'`,
    hard_delete: (c) => c`delete from artifact where id = 'hub-a'`,
  };

  async function raceFinalizeAgainstHubMutation(
    mutation: string,
    opts: { statementTimeoutMs: number },
  ): Promise<{ deadlocked: boolean }> {
    const prepared = await preparedClaim();
    const results = await Promise.allSettled([
      (async () => {
        try {
          return await finalizeHubSync(testDb(), {
            claim: prepared.claim,
            desired: prepared.desired,
            mode: 'apply',
          });
        } catch (err) {
          if (isDeadlock(err)) throw err;
          return 'finalize-error';
        }
      })(),
      withStatementTimeout(opts.statementTimeoutMs, (c) => HUB_MUTATIONS[mutation](c)),
    ]);
    const deadlocked = results.some(
      (r) => r.status === 'rejected' && isDeadlock((r as PromiseRejectedResult).reason),
    );
    return { deadlocked };
  }

  async function reconciliationMatchesCurrentHub(artifactId: string): Promise<boolean> {
    const hubRows = await testDb().execute<{ type: string; archived_at: Date | null }>(
      sql`select type, archived_at from artifact where id = ${artifactId}`,
    );
    const cursorRows = await testDb().execute<{ status: string }>(
      sql`select status from hub_sync_reconciliation where artifact_id = ${artifactId}`,
    );
    const hub = hubRows[0];
    const cursor = cursorRows[0];
    if (!hub) return cursor === undefined; // hard delete cascades the cursor away
    const live = hub.type === 'note_hub' && hub.archived_at === null;
    return live
      ? cursor !== undefined && cursor.status !== 'cancelled'
      : cursor === undefined || cursor.status === 'cancelled';
  }

  function repairWithBarrier(key: string, _at: string) {
    const barrier = new FinalizeBarrier(_at);
    const done = repairHubSyncCoverage(
      testDb(),
      { repairKey: key, pageSize: 100 },
      { beforeArtifactLock: () => barrier.hit() },
    );
    return { barrier, done };
  }

  async function archiveThenRestoreHub(id: string) {
    await testDb().execute(
      sql`update artifact set archived_at = clock_timestamp() where id = ${id}`,
    );
    await testDb().execute(sql`update artifact set archived_at = null where id = ${id}`);
  }

  it.each(['archive', 'restore', 'suppression', 'body_save', 'hard_delete'] as const)(
    'YUK-384 RED 19: %s racing finalization cannot deadlock or leave stale cancellation',
    async (mutation) => {
      const result = await raceFinalizeAgainstHubMutation(mutation, { statementTimeoutMs: 2_000 });
      expect(result.deadlocked).toBe(false);
      expect(await reconciliationMatchesCurrentHub('hub-a')).toBe(true);
    },
  );

  it('YUK-384 RED 20: nightly repair rechecks archive and restore under artifact lock', async () => {
    const repair = repairWithBarrier('nightly:2026-07-21', 'before-artifact-lock');
    await repair.barrier.waitUntilReached();
    await archiveThenRestoreHub('hub-a');
    repair.barrier.release();
    await repair.done;
    expect(await state('hub-a')).toMatchObject({ status: 'pending' });
  });

  it('YUK-384 RED 21: duplicate nightly repair key increments each hub at most once', async () => {
    const key = 'nightly:2026-07-21';
    await repairHubSyncCoverage(testDb(), { repairKey: key, pageSize: 100 });
    const once = await generation('hub-a');
    await repairHubSyncCoverage(testDb(), { repairKey: key, pageSize: 100 });
    expect(await generation('hub-a')).toBe(once);
  });

  it('YUK-384: nightly repair pages past pageSize so EVERY live hub is dirtied in one run', async () => {
    // beforeEach seeds hub-a; add two more → 3 live hubs while pageSize (= maxArtifacts)
    // is 2, forcing more than one keyset page. The pre-fix single-page scan stamps only
    // hub-a/hub-b and abandons hub-c; the fix loops pages until hasMore is false.
    await seedHub('hub-b', ['kc']);
    await seedHub('hub-c', ['kc']);
    const key = 'nightly:2026-07-21';
    await runHubSyncCycle(testDb(), {
      reason: 'nightly_repair',
      repairKey: key,
      maxArtifacts: 2,
      mode: 'shadow',
    });
    for (const id of ['hub-a', 'hub-b', 'hub-c']) {
      const rows = await testDb().execute<{ last_repair_key: string | null }>(
        sql`select last_repair_key from hub_sync_reconciliation where artifact_id = ${id}`,
      );
      expect(rows[0]?.last_repair_key).toBe(key);
    }
  });

  it('YUK-384: keyset repair page returns lastId and does not re-scan the same head every call', async () => {
    await seedHub('hub-b', ['kc']);
    await seedHub('hub-c', ['kc']);
    const key = 'nightly:2026-07-21';
    const page1 = await repairHubSyncCoverage(testDb(), { repairKey: key, pageSize: 2 });
    expect(page1.hasMore).toBe(true);
    expect(page1.lastId).toBe('hub-b'); // ids ordered: hub-a, hub-b, hub-c
    const page2 = await repairHubSyncCoverage(testDb(), {
      repairKey: key,
      pageSize: 2,
      afterId: page1.lastId,
    });
    expect(page2.hasMore).toBe(false);
    expect(page2.dirtied).toBe(1); // only hub-c remains past the cursor
  });
});

// ── Task 8 (RED Tests 22–24): unified wake / recovery / continuation / retry ──

describe('YUK-384 unified hub-sync cycle', () => {
  beforeEach(async () => {
    await resetDb();
    process.env.HUB_SYNC_MODE = 'apply';
    await seedKnowledge('kc');
    // One live atomic sharing kc so every seeded hub computes a real auto-zone
    // change (changed=true → applies).
    await seedArtifact({
      id: 'atomic-shared',
      type: 'note_atomic',
      knowledgeIds: ['kc'],
      title: 'Shared',
    });
  });

  afterEach(() => {
    process.env.HUB_SYNC_MODE = 'off';
  });

  async function seedAppliableHub(id: string) {
    await seedArtifact({ id, type: 'note_hub', knowledgeIds: ['kc'] });
  }

  async function seedReadyHubs(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const id = `hub-${String(i).padStart(3, '0')}`;
      await seedAppliableHub(id);
      ids.push(id);
    }
    return ids;
  }

  async function injectDesiredStateFailureFor(id: string): Promise<void> {
    // An invalid body makes the desired document invalid → finalize throws a
    // classified (retryable) failure.
    await testDb().execute(
      sql`update artifact set body_blocks = '{"bad":true}'::jsonb where id = ${id}`,
    );
  }

  async function readyCount(): Promise<number> {
    const rows = await testDb().execute<{ count: string }>(sql`
      select count(*)::text as count from hub_sync_reconciliation
      where status in ('pending', 'retry_wait') and next_attempt_at <= clock_timestamp()
    `);
    return Number(rows[0]?.count ?? '0');
  }

  async function claimCounts(): Promise<number[]> {
    const rows = await testDb().execute<{ claim_count: number }>(
      sql`select claim_count from hub_sync_reconciliation`,
    );
    return rows.map((r) => Number(r.claim_count));
  }

  async function retryDelayMs(id: string): Promise<number> {
    const rows = await testDb().execute<{ ms: string }>(sql`
      select extract(epoch from (next_attempt_at - last_error_at)) * 1000 as ms
      from hub_sync_reconciliation where artifact_id = ${id}
    `);
    return Number(rows[0]?.ms);
  }

  async function topologyMutationWithWake(deps: {
    send: (queue: string, data: unknown, options?: { singletonKey?: string }) => Promise<unknown>;
  }): Promise<void> {
    // A real topology commit dirties every live hub via the trigger…
    await testDb().execute(sql`update knowledge set name = 'woken' where id = 'kc'`);
    // …then a best-effort post-commit wake (which may fail — durability is the
    // trigger + minute recovery, never this send).
    await sendHubSyncMutationWake(deps);
  }

  it('YUK-384 RED 22: failed immediate send converges through minute recovery', async () => {
    await seedAppliableHub('hub-a');
    await topologyMutationWithWake({
      send: vi.fn().mockRejectedValue(new Error('boss unavailable')),
    });
    expect(await state('hub-a')).toMatchObject({ status: 'pending' });

    await runHubSyncCycle(testDb(), { reason: 'recovery', maxArtifacts: 25, mode: 'apply' });
    expect(await state('hub-a')).toMatchObject({ status: 'acknowledged' });
  });

  it('YUK-384 RED 23: bounded cycle emits one continuation and drains fairly', async () => {
    await seedReadyHubs(30);
    const send = vi.fn().mockResolvedValue('job-id');
    const db = testDb();

    const first = await buildHubSyncRecoveryHandler(db, { send })();
    expect(first.claimed).toBe(25);
    expect(send).toHaveBeenCalledTimes(1);
    expect(first.continuation_needed).toBe(true);

    await buildHubSyncRecoveryHandler(db, { send })();
    expect(await readyCount()).toBe(0);
    const counts = await claimCounts();
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it('YUK-384 RED 24: one hub failure schedules durable retry and later hubs continue', async () => {
    const ids = await seedReadyHubs(3);
    await injectDesiredStateFailureFor(ids[1]);

    const result = await runHubSyncCycle(testDb(), {
      reason: 'recovery',
      maxArtifacts: 3,
      mode: 'apply',
    });
    expect(result).toMatchObject({ claimed: 3, applied: 2, retry_scheduled: 1 });
    expect(await state(ids[1])).toMatchObject({
      status: 'retry_wait',
      consecutive_failure_count: 1,
    });
    expect(await retryDelayMs(ids[1])).toBeGreaterThanOrEqual(5_000);
    expect(await retryDelayMs(ids[1])).toBeLessThanOrEqual(6_000);
  });

  it('YUK-384: a hub with a malformed auto-links container self-heals instead of wedging in infinite retry', async () => {
    await seedAppliableHub('hub-a');
    // Poison pill: an auto-links container node with NO attrs.id. A replace_block
    // targeting the canonical fallback id would miss → target_not_found → the pre-fix
    // reconciler classifies it retryable and the hub wedges forever.
    const malformed = {
      type: 'doc',
      content: [{ type: 'autoLinksContainer', attrs: { title: 'Related' }, content: [] }],
    };
    await testDb().execute(
      sql`update artifact set body_blocks = ${JSON.stringify(malformed)}::jsonb where id = 'hub-a'`,
    );

    await runHubSyncCycle(testDb(), { reason: 'recovery', maxArtifacts: 5, mode: 'apply' });

    // Converged (acknowledged), NOT stuck in retry_wait.
    expect(await state('hub-a')).toMatchObject({ status: 'acknowledged', last_outcome: 'applied' });
    // The container was healed with the canonical id so it renders/updates thereafter.
    const rows = await testDb().execute<{ body: { content?: { attrs?: { id?: unknown } }[] } }>(
      sql`select body_blocks as body from artifact where id = 'hub-a'`,
    );
    const container = rows[0].body.content?.find(
      (n) => (n as { type?: string }).type === 'autoLinksContainer',
    );
    expect((container as { attrs?: { id?: unknown } }).attrs?.id).toBe('hub-a__auto_links');
  });

  it('YUK-384: a recordHubSyncRetry failure on one hub does not abort the cycle', async () => {
    await seedAppliableHub('hub-a');
    await seedAppliableHub('hub-b');
    await seedAppliableHub('hub-c');
    // All three fail finalize (invalid desired doc) → each enters the retry path.
    await injectDesiredStateFailureFor('hub-a');
    await injectDesiredStateFailureFor('hub-b');
    await injectDesiredStateFailureFor('hub-c');
    // Poison ONLY hub-b's retry-record: int4 max consecutive_failure_count overflows on
    // the +1 inside recordHubSyncRetry → its UPDATE throws for hub-b alone.
    await testDb().execute(
      sql`update hub_sync_reconciliation set consecutive_failure_count = 2147483647 where artifact_id = 'hub-b'`,
    );

    await runHubSyncCycle(testDb(), { reason: 'recovery', maxArtifacts: 25, mode: 'apply' });

    // hub-c is claimed AFTER hub-b (artifact_id order). Pre-fix, hub-b's retry-record
    // throw escaped reconcileClaim and aborted the for-loop, abandoning hub-c.
    expect(await state('hub-a')).toMatchObject({ status: 'retry_wait' });
    expect(await state('hub-c')).toMatchObject({ status: 'retry_wait' });
  });

  it('YUK-384: shadow mode observes without consuming the obligation (stays pending, ack unchanged)', async () => {
    await seedAppliableHub('hub-a');
    const before = await state('hub-a');
    expect(before.acknowledged_generation).toBe('0');

    await runHubSyncCycle(testDb(), { reason: 'recovery', maxArtifacts: 5, mode: 'shadow' });

    const shadowed = await state('hub-a');
    // NOT consumed: stays pending with acknowledged_generation UNCHANGED (the old
    // acknowledgeNoop path advanced ack + set status=acknowledged → apply mode skipped it).
    expect(shadowed.status).toBe('pending');
    expect(shadowed.acknowledged_generation).toBe('0');
    expect(shadowed.last_outcome).toBe('shadowed');

    // The obligation survives → apply mode re-claims and converges (the shadow re-observe
    // backoff having elapsed, simulated by resetting next_attempt_at).
    await testDb().execute(
      sql`update hub_sync_reconciliation set next_attempt_at = clock_timestamp() where artifact_id = 'hub-a'`,
    );
    await runHubSyncCycle(testDb(), { reason: 'recovery', maxArtifacts: 5, mode: 'apply' });
    expect(await state('hub-a')).toMatchObject({ status: 'acknowledged', last_outcome: 'applied' });
  });

  it('YUK-384 (minor A): shadow observations increment the shadowed cycle counter', async () => {
    await seedAppliableHub('hub-a');
    const result = await runHubSyncCycle(testDb(), {
      reason: 'recovery',
      maxArtifacts: 5,
      mode: 'shadow',
    });
    // The 'shadowed' switch case used to be empty → shadow cycles were unobservable.
    expect(result.claimed).toBe(1);
    expect(result.shadowed).toBe(1);
    expect(result.applied).toBe(0);
  });

  it('YUK-384 (minor B): continuation_needed sees claimed/applying cursors with expired leases', async () => {
    await seedAppliableHub('hub-a');
    // A worker died mid-claim: the cursor is 'claimed' with an EXPIRED lease (reclaimable).
    await testDb().execute(sql`
      update hub_sync_reconciliation
      set status = 'claimed', claim_owner = 'dead', claim_token = 't',
          lease_expires_at = clock_timestamp() - interval '1 minute'
      where artifact_id = 'hub-a'
    `);
    // maxArtifacts 0 → claim nothing; only the end-of-cycle hasReadyHubSync runs.
    const result = await runHubSyncCycle(testDb(), {
      reason: 'recovery',
      maxArtifacts: 0,
      mode: 'apply',
    });
    // Pre-fix hasReadyHubSync only counted pending/retry_wait → this backlog of dead-lease
    // cursors under-reported and no continuation was dispatched to drain it.
    expect(result.continuation_needed).toBe(true);
  });

  it('YUK-384 (minor G): sweepAbandonedEditSessions reaps rows past the TTL, keeps fresh', async () => {
    await seedAppliableHub('hub-a');
    await testDb().execute(sql`
      insert into artifact_edit_session (artifact_id, session_id, started_at, last_heartbeat_at)
      values
        ('hub-a', 'abandoned', clock_timestamp() - interval '2 hours', clock_timestamp() - interval '2 hours'),
        ('hub-a', 'fresh', clock_timestamp(), clock_timestamp())
    `);
    await sweepAbandonedEditSessions(testDb());
    const rows = await testDb().execute<{ session_id: string }>(
      sql`select session_id from artifact_edit_session where artifact_id = 'hub-a' order by session_id`,
    );
    expect(rows.map((r) => r.session_id)).toEqual(['fresh']);
  });

  it('YUK-384 (item-8 revert): a hub claimed at a mid-cycle-bumped generation reconciles against a graph current as of its claim (no stale-graph apply)', async () => {
    await seedAppliableHub('hub-a');
    await seedAppliableHub('hub-b');

    // After reconciling the first hub, add a NEW atomic sharing kc. The trigger dirties
    // every live hub, so hub-b is re-claimed at the bumped generation — the write-side
    // generation/token/lease fence passes (the claim was taken AT the new generation). A
    // per-cycle graph snapshot (loaded before the injection) would compute hub-b's body
    // WITHOUT the new cross-link and ack the bump anyway: the read-side stale-win the fence
    // cannot catch. Loading the graph fresh per claim is the fix.
    let injected = false;
    await runHubSyncCycle(testDb(), {
      reason: 'recovery',
      maxArtifacts: 25,
      mode: 'apply',
      afterReconcile: async () => {
        if (injected) return;
        injected = true;
        await seedArtifact({
          id: 'atomic-mid',
          type: 'note_atomic',
          knowledgeIds: ['kc'],
          title: 'Mid-cycle atomic',
        });
      },
    });

    // hub-b's applied body must include the mid-cycle atomic's cross-link.
    const rows = await testDb().execute<{
      body: { content?: { type?: string; content?: { attrs?: { artifact_id?: unknown } }[] }[] };
    }>(sql`select body_blocks as body from artifact where id = 'hub-b'`);
    const container = rows[0].body.content?.find((n) => n.type === 'autoLinksContainer');
    const childArtifactIds = (container?.content ?? []).map((c) => c.attrs?.artifact_id);
    expect(childArtifactIds).toContain('atomic-mid');
  });

  it('YUK-384 (codex P2): a recovered invalid_document hub clears last_error_* on success ack so health stops counting it', async () => {
    await seedAppliableHub('hub-a'); // valid body → finalize will apply

    // Simulate a hub that PREVIOUSLY failed invalid_document and sits in retry_wait, whose
    // doc/code is now fixed. Set the error + retry_wait state DIRECTLY (no re-dirty): this is
    // the code-fix recovery path — the cursor is reclaimed via retry backoff, NOT a fresh
    // topology dirty (which would go through mark_hub_sync_dirty and reset the cursor). The
    // only thing that can clear last_error_* on this path is the success ack.
    await testDb().execute(sql`
      update hub_sync_reconciliation
      set status = 'retry_wait', consecutive_failure_count = 1,
          last_error_class = 'invalid_document', last_error_code = 'INVALID_DOCUMENT',
          last_error = 'desired hub document is invalid',
          last_error_at = clock_timestamp() - interval '120 seconds',
          next_attempt_at = clock_timestamp()
      where artifact_id = 'hub-a'
    `);
    const sick = await readHubSyncHealth(testDb());
    expect(sick.invalid_document_count).toBe(1);
    expect(sick.oldest_invalid_age_seconds).not.toBeNull();

    // Reclaim + finalize (valid body → applies) → the success ack must clear last_error_*.
    await runHubSyncCycle(testDb(), { reason: 'recovery', maxArtifacts: 5, mode: 'apply' });

    expect(await state('hub-a')).toMatchObject({ status: 'acknowledged', last_error_class: null });
    const healed = await readHubSyncHealth(testDb());
    expect(healed.invalid_document_count).toBe(0);
    expect(healed.oldest_invalid_age_seconds).toBeNull();
  });

  it('YUK-384 (shadow gauge): observeShadowNoApply clears diagnostic state so a recovered hub is not counted under shadow', async () => {
    await seedAppliableHub('hub-a'); // valid + changed body → shadow observes (not applies)

    // Prior failure state, now recovered (doc valid). Set directly (code-fix recovery path).
    await testDb().execute(sql`
      update hub_sync_reconciliation
      set status = 'retry_wait', consecutive_failure_count = 3,
          last_error_class = 'invalid_document', last_error_code = 'INVALID_DOCUMENT',
          last_error = 'desired hub document is invalid',
          last_error_at = clock_timestamp() - interval '120 seconds',
          next_attempt_at = clock_timestamp()
      where artifact_id = 'hub-a'
    `);
    const sick = await readHubSyncHealth(testDb());
    expect(sick.invalid_document_count).toBe(1);
    expect(sick.max_consecutive_failure_count).toBe(3);

    // Reclaim under SHADOW → observeShadowNoApply (doc valid + changed → observed, not applied).
    await runHubSyncCycle(testDb(), { reason: 'recovery', maxArtifacts: 5, mode: 'shadow' });

    // Obligation intact (still pending, ack unchanged) but diagnostic state cleared.
    const s = await state('hub-a');
    expect(s.status).toBe('pending');
    expect(s.last_outcome).toBe('shadowed');
    expect(s.last_error_class).toBeNull();
    expect(s.consecutive_failure_count).toBe(0);
    const healed = await readHubSyncHealth(testDb());
    expect(healed.invalid_document_count).toBe(0);
    expect(healed.max_consecutive_failure_count).toBe(0);
  });

  it('YUK-384 (F1): recordHubSyncRetry records the backoff even when the lease already expired (token still owns the claim)', async () => {
    await seedAppliableHub('hub-a');
    const token = 'tok-expired-lease';
    // A claimed cursor whose lease EXPIRED but whose token still matches — a slow worker
    // whose renewer was blocked on the row lock. Pre-fix the lease-fenced retry matched 0
    // rows → no backoff / failure_count / last_error → reclaim arm saw only an expired lease.
    await testDb().execute(sql`
      update hub_sync_reconciliation
      set status = 'claimed', claim_owner = 'w1', claim_token = ${token},
          lease_expires_at = clock_timestamp() - interval '1 minute', consecutive_failure_count = 0
      where artifact_id = 'hub-a'
    `);
    const gen = await generation('hub-a');
    const affected = await recordHubSyncRetry(
      testDb(),
      {
        artifactId: 'hub-a',
        generation: gen,
        claimToken: token,
        claimOwner: 'w1',
        leaseExpiresAt: new Date(),
      },
      { errorClass: 'apply_validation_error', code: 'X', message: 'x' },
    );
    expect(affected).toBe(1);
    const s = await state('hub-a');
    expect(s.status).toBe('retry_wait');
    expect(s.consecutive_failure_count).toBe(1);
    expect(s.last_error_class).toBe('apply_validation_error');
    expect(await retryDelayMs('hub-a')).toBeGreaterThanOrEqual(5_000);

    // But a rotated token (a genuine reclaim) must STILL be fenced out — 0 rows, no clobber.
    const zero = await recordHubSyncRetry(
      testDb(),
      {
        artifactId: 'hub-a',
        generation: gen,
        claimToken: 'stale-token',
        claimOwner: 'w0',
        leaseExpiresAt: new Date(),
      },
      { errorClass: 'apply_validation_error', code: 'X', message: 'x' },
    );
    expect(zero).toBe(0);
  });

  it('YUK-384 (F2): an active-editor defer backs next_attempt_at off by ~30s (no tight reclaim loop)', async () => {
    await seedAppliableHub('hub-a');
    await testDb().execute(sql`
      insert into artifact_edit_session (artifact_id, session_id, started_at, last_heartbeat_at)
      values ('hub-a', 'editor', clock_timestamp(), clock_timestamp())
    `);
    await runHubSyncCycle(testDb(), { reason: 'recovery', maxArtifacts: 5, mode: 'apply' });

    const s = await state('hub-a');
    expect(s.status).toBe('pending');
    expect(s.last_outcome).toBe('active_editor');
    const rows = await testDb().execute<{ secs: string }>(sql`
      select extract(epoch from (next_attempt_at - clock_timestamp())) as secs
      from hub_sync_reconciliation where artifact_id = 'hub-a'
    `);
    // ~30s backoff (pre-fix this was ~0 → tight ~100ms reclaim loop during editing).
    expect(Number(rows[0].secs)).toBeGreaterThan(20);
    expect(Number(rows[0].secs)).toBeLessThanOrEqual(30);
  });

  it('YUK-384 (F3a): a hub whose auto-links container is user_verified still applies (reconciler owns the auto-zone) — no poison', async () => {
    await seedAppliableHub('hub-a');
    // An auto-links container the user marked verified. Pre-fix replace_block threw
    // user_verified_protected → NoteRefineApplyError → (F3b) misclassified pg_transient →
    // infinite retry. The reconciler is the auto-zone owner, so the guard must be off here.
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'autoLinksContainer',
          attrs: { id: 'hub-a__auto_links', user_verified: true },
          content: [],
        },
      ],
    };
    await testDb().execute(
      sql`update artifact set body_blocks = ${JSON.stringify(doc)}::jsonb where id = 'hub-a'`,
    );
    await runHubSyncCycle(testDb(), { reason: 'recovery', maxArtifacts: 5, mode: 'apply' });
    expect(await state('hub-a')).toMatchObject({ status: 'acknowledged', last_outcome: 'applied' });
  });

  it('YUK-384 (F3b): classifyHubSyncError maps NoteRefineApplyError to apply_validation_error, not pg_transient', () => {
    expect(
      classifyHubSyncError(new NoteRefineApplyError('user_verified_protected', 'm')),
    ).toMatchObject({ errorClass: 'apply_validation_error', code: 'user_verified_protected' });
    // A genuine 5-char SQLSTATE is still pg_transient.
    expect(classifyHubSyncError({ code: '40001' })).toMatchObject({ errorClass: 'pg_transient' });
    // X2: 40P01 (deadlock_detected — the atomic hard-delete vs finalizer FK deadlock) is a
    // 5-char SQLSTATE → pg_transient → classified retry → the finalize side self-heals.
    expect(classifyHubSyncError({ code: '40P01' })).toMatchObject({ errorClass: 'pg_transient' });
    // A non-SQLSTATE business `.code` is NOT pg_transient (was the bug).
    expect(classifyHubSyncError({ code: 'some_business_code' })).toMatchObject({
      errorClass: 'unknown',
    });
  });

  it('YUK-384 (X1): a reconciler apply is fold-replayable — fold(events).body_blocks == row.body_blocks', async () => {
    await seedAppliableHub('hub-a');
    // Genesis BASE (v0, seed body) so the fold has a base, like the real event-sourced stream.
    // `NOW` (2026-07-21) < the apply event's real created_at → genesis sorts first.
    await backfillArtifactGenesis(testDb(), NOW);

    await runHubSyncCycle(testDb(), { reason: 'recovery', maxArtifacts: 5, mode: 'apply' });

    const rows = await testDb().execute<{ body: unknown; version: number }>(
      sql`select body_blocks as body, version from artifact where id = 'hub-a'`,
    );
    const folded = await gatherAndFoldArtifact(testDb(), 'hub-a');
    // Pre-fix (experimental:hub_sync_apply, ignored by foldArtifact): the fold stayed at the
    // genesis body → drift. Post-fix (full-snapshot body_blocks_edit): fold == row.
    expect(folded).not.toBeNull();
    expect(folded?.body_blocks).toEqual(rows[0].body);
    expect(folded?.version).toBe(rows[0].version);
  });

  it('YUK-384 (X1): the container-heal apply is also fold-replayable (full snapshot, no op-replay throw)', async () => {
    await seedAppliableHub('hub-a');
    // A malformed auto-links container (no attrs.id) → the reconciler heals it during apply.
    const malformed = {
      type: 'doc',
      content: [{ type: 'autoLinksContainer', attrs: { title: 'Related' }, content: [] }],
    };
    await testDb().execute(
      sql`update artifact set body_blocks = ${JSON.stringify(malformed)}::jsonb where id = 'hub-a'`,
    );
    await backfillArtifactGenesis(testDb(), NOW); // genesis captures the MALFORMED body

    await runHubSyncCycle(testDb(), { reason: 'recovery', maxArtifacts: 5, mode: 'apply' });

    const rows = await testDb().execute<{ body: unknown }>(
      sql`select body_blocks as body from artifact where id = 'hub-a'`,
    );
    const folded = await gatherAndFoldArtifact(testDb(), 'hub-a');
    // The full-snapshot event reproduces the HEALED after-body verbatim. An op-replay event
    // would have thrown target_not_found replaying the container patch on the un-healed
    // genesis body → fold warn+skip → drift. This is why body_blocks_edit is mandatory here.
    expect(folded?.body_blocks).toEqual(rows[0].body);
  });
});
