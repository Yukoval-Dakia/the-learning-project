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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { artifact, knowledge, knowledge_edge } from '@/db/schema';
import { gatherAndFoldArtifact } from '@/server/projections/gather';
import { backfillArtifactGenesis } from '../../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  type HubDesiredState,
  type HubSyncClaim,
  claimNextHubSync,
  computeHubDesiredState,
  finalizeHubSync,
  repairHubSyncCoverage,
  runHubSyncCycle,
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

// ── YUK-782: deterministic concurrency primitives for the lock-order tests ────
//
// The cursor-lock tests below must NOT race a wall clock. Two primitives replace
// "sleep and hope": a transaction that parks on named hub_sync_reconciliation
// rows, and a barrier that waits until a specific backend is observably blocked
// on a heavyweight lock (pg_stat_activity.wait_event_type = 'Lock').

// Both budgets sit inside the 30s testTimeout even if they compound, and the
// statement budget sits far above Postgres' 1s deadlock_timeout so a lock-order
// regression always surfaces as a detected deadlock, never as a timeout.
const LOCK_BARRIER_TIMEOUT_MS = 10_000;
const LOCK_STATEMENT_TIMEOUT_MS = 15_000;

// Holds `FOR UPDATE` on the given cursor rows in sorted order until released, so
// any trigger that reaches mark_hub_sync_dirty for one of them must park.
async function holdCursorLocks(
  artifactIds: string[],
): Promise<{ release: () => void; done: Promise<unknown> }> {
  const held = createDeferred();
  const release = createDeferred();
  const done = rawClient().begin(async (c) => {
    await c`select artifact_id from hub_sync_reconciliation
            where artifact_id in ${c(artifactIds)} order by artifact_id for update`;
    held.resolve();
    await release.promise;
  });
  await held.promise;
  return { release: () => release.resolve(), done };
}

// Starts one hub→atomic transition in its own transaction and exposes its
// backend pid, which the barrier below polls.
function startTypeTransition(artifactId: string): { pid: Promise<number>; done: Promise<unknown> } {
  const pid = createDeferred<number>();
  const done = rawClient().begin(async (c) => {
    const [row] = await c<{ pid: number }[]>`select pg_backend_pid() as pid`;
    pid.resolve(Number(row.pid));
    await c.unsafe(`SET LOCAL statement_timeout = ${LOCK_STATEMENT_TIMEOUT_MS}`);
    return c`update artifact set type = 'note_atomic' where id = ${artifactId}`;
  });
  return { pid: pid.promise, done };
}

// Barrier: resolves once EVERY listed backend is parked in a heavyweight lock
// wait. Because plpgsql evaluates the trigger's fan-out target query before its
// first mark_hub_sync_dirty call, "parked" proves each transition has already
// computed its target set — and, since none of them can have committed while
// parked, every target set was computed against a graph where the other hub is
// still a live note_hub. That is what makes the +2 generation deltas an
// invariant rather than a scheduling coincidence.
async function waitUntilParkedOnLock(pids: number[]): Promise<void> {
  // Numeric-coerced before interpolation: these are backend pids read back from
  // Postgres, never test-authored text.
  const pidList = pids.map((pid) => Number(pid)).join(',');
  const deadline = Date.now() + LOCK_BARRIER_TIMEOUT_MS;
  for (;;) {
    const rows = await testDb().execute<{ parked: string }>(sql`
      select count(*)::text as parked from pg_stat_activity
      where pid = any(${sql.raw(`array[${pidList}]::int[]`)})
        and state = 'active' and wait_event_type = 'Lock'
    `);
    if (Number(rows[0]?.parked ?? '0') === pids.length) return;
    if (Date.now() > deadline) {
      throw new Error(`barrier timeout: backends ${pids.join(',')} never parked on a lock`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const LOCK_NOT_AVAILABLE = '55P03';

// Folds a settled transition into an assertable label. Carrying the SQLSTATE
// into the assertion makes a lock-order regression self-diagnosing: the diff
// prints `rejected:40P01` (deadlock_detected) instead of a bare `rejected`.
function settledLabel(result: PromiseSettledResult<unknown>): string {
  if (result.status === 'fulfilled') return 'fulfilled';
  const reason = result.reason as { code?: string; message?: string } | undefined;
  return `rejected:${reason?.code ?? reason?.message ?? 'unknown'}`;
}

// Tries to take the cursor row without waiting. `false` means some other
// transaction already holds it.
async function cursorLockIsFree(artifactId: string): Promise<boolean> {
  try {
    await rawClient().begin(async (c) => {
      await c`select artifact_id from hub_sync_reconciliation
              where artifact_id = ${artifactId} for update nowait`;
    });
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === LOCK_NOT_AVAILABLE) return false;
    throw err;
  }
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

  // YUK-782 — this test used to build its concurrency window out of wall clock:
  // a blocker on the ARTIFACT rows plus `pg_sleep(0.1)` plus a 2s
  // statement_timeout. On a loaded runner the two transitions could simply
  // serialize, and a serialized pair legitimately yields [+1, +2] (the second
  // transition's snapshot already sees the first hub as note_atomic, so it has
  // no live hub left to fan out to) — the exact `[2n, 3n] != [3n, 3n]` failure
  // that reddened CI twice on diffs with zero hub-sync overlap.
  //
  // The blocker now parks on the hub_sync_reconciliation CURSOR rows instead,
  // and the window is closed by observation (waitUntilParkedOnLock) rather than
  // by a sleep. Both transitions are proven to have computed their fan-out
  // target sets before either can commit, which makes +2/+2 an invariant. It
  // also makes a lock-order regression deadlock deterministically: with both
  // cursors held, a trigger that locked the transitioned hub first would leave
  // hub-a's transition holding hub-a and wanting hub-b while hub-b's transition
  // holds hub-b and wants hub-a.
  it('YUK-746/YUK-782: concurrent hub-to-atomic transitions share one global cursor lock order', async () => {
    await seedHub('hub-b', ['k2']);
    const before = await generations(['hub-a', 'hub-b']);
    const blocker = await holdCursorLocks(['hub-a', 'hub-b']);

    const left = startTypeTransition('hub-a');
    const right = startTypeTransition('hub-b');
    let settled: PromiseSettledResult<unknown>[];
    try {
      await waitUntilParkedOnLock([await left.pid, await right.pid]);
    } finally {
      blocker.release();
      await blocker.done;
      settled = await Promise.allSettled([left.done, right.done]);
    }

    // No 40P01: sorted cursor acquisition means the two transitions queue on the
    // same first cursor instead of forming a cycle.
    expect(settled.map(settledLabel)).toEqual(['fulfilled', 'fulfilled']);
    // Each hub takes its own type-loss cancel (+1) AND the other's atomic
    // fan-out (+1).
    expect(await generations(['hub-a', 'hub-b'])).toEqual(before.map((value) => value + 2n));
    const transitioned = await testDb()
      .select({ id: artifact.id, type: artifact.type })
      .from(artifact)
      .where(sql`${artifact.id} in ('hub-a', 'hub-b')`);
    expect(transitioned).toEqual(
      expect.arrayContaining([
        { id: 'hub-a', type: 'note_atomic' },
        { id: 'hub-b', type: 'note_atomic' },
      ]),
    );
    // Deliberately NOT asserted here: the final cursor `status`. Each hub is
    // cancelled by its own type-loss but re-marked pending by the other's
    // fan-out, so which of the two lands last is a scheduling detail, not an
    // invariant. RED 19 owns cursor-vs-hub consistency.
  });

  // YUK-782 — a direct, single-writer assertion on the acquisition ORDER itself,
  // so the lock-order invariant no longer depends on winning a scheduling race
  // to provoke a deadlock. One cursor is held hostage; the transition is run and
  // observed while parked; a NOWAIT probe then reads which cursors it had
  // already taken at that moment.
  //
  // Two mirrored halves pin sorted-by-artifact-id acquisition from both sides:
  // locking the transitioned hub first fails the first half, and locking the
  // fan-out set first fails the second.
  it('YUK-782: a hub-to-atomic transition takes cursors in sorted artifact-id order, transitioned hub included', async () => {
    await seedHub('hub-b', ['k2']);

    // Half 1 — hostage is the FIRST id (hub-a); transition the LAST (hub-b).
    // Sorted order forces hub-a first, so hub-b's own cursor must still be free.
    const firstHostage = await holdCursorLocks(['hub-a']);
    let ownCursorStillFree: boolean;
    let lastSettled: PromiseSettledResult<unknown>;
    const transitionLast = startTypeTransition('hub-b');
    try {
      await waitUntilParkedOnLock([await transitionLast.pid]);
      ownCursorStillFree = await cursorLockIsFree('hub-b');
    } finally {
      // allSettled so a failing transition can never mask the real assertion
      // error; its status is asserted explicitly below instead.
      firstHostage.release();
      await firstHostage.done;
      [lastSettled] = await Promise.allSettled([transitionLast.done]);
    }
    expect(settledLabel(lastSettled)).toBe('fulfilled');
    expect(ownCursorStillFree).toBe(true);

    // Half 2 — hostage is the LAST id (hub-b); transition the FIRST (hub-a).
    // Sorted order means hub-a is already taken before the wait on hub-b.
    await testDb().execute(sql`update artifact set type = 'note_hub' where id = 'hub-b'`);
    const lastHostage = await holdCursorLocks(['hub-b']);
    let earlierCursorAlreadyTaken: boolean;
    let firstSettled: PromiseSettledResult<unknown>;
    const transitionFirst = startTypeTransition('hub-a');
    try {
      await waitUntilParkedOnLock([await transitionFirst.pid]);
      earlierCursorAlreadyTaken = !(await cursorLockIsFree('hub-a'));
    } finally {
      lastHostage.release();
      await lastHostage.done;
      [firstSettled] = await Promise.allSettled([transitionFirst.done]);
    }
    expect(settledLabel(firstSettled)).toBe('fulfilled');
    expect(earlierCursorAlreadyTaken).toBe(true);
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

async function claimRequired(owner: string): Promise<HubSyncClaim> {
  const claim = await claimNextHubSync(testDb(), { owner });
  if (!claim) throw new Error(`expected a claim for ${owner}`);
  return claim;
}

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

  it('a reconciler apply replays the complete artifact, including its exact update time', async () => {
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
    const [live] = await testDb().select().from(artifact).where(eq(artifact.id, 'hub-a'));
    expect(folded).toEqual(live);
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
