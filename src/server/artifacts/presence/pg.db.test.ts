// PgPresenceStore 契约测试 — YUK-384 session-qualified 重写。
//
// 三个关注点：
//   1. session presence（artifact_edit_session）：心跳 upsert、按 session 删、
//      30s 活跃边界、DB-time 判定（RED 15 / RED 17）。
//   2. NON-HUB note-refine defer 队列（editing_presence.pending，保留）：idle 立即
//      apply、活跃会话 defer、末个会话 blur 才 flush、陈旧 pending 丢弃（裁决 i）。
//   3. 跨进程：两实例共享同一 PG。
//
// artifact_edit_session 有 FK → artifact，故每个用到的 artifact 必须先 seed。
// persistNoteRefineApply 被 mock（apply 副作用与 presence 判定解耦）。

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotePatchT } from '@/core/schema/note-patch';

import { resetDb, testDb } from '../../../../tests/helpers/db';

const persistNoteRefineApply = vi.fn(async (args: { artifactId: string }) => ({
  status: 'applied' as const,
  artifact_id: args.artifactId,
}));
vi.mock('@/capabilities/notes/server/note-refine-apply', () => ({
  persistNoteRefineApply: (args: { artifactId: string }) => persistNoteRefineApply(args),
}));

// pg.ts 必须在 mock 之后导入。
import { artifact, editing_presence } from '@/db/schema';
import { PgPresenceStore } from './pg';
import { HUB_AUTO_SYNC_ACTOR_REF } from './types';

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const patch = { ops: [{ kind: 'append_block', block: {} }] } as unknown as NotePatchT;
const applyDb = {} as never; // apply 走 mock，无需真实 db
const T0 = new Date('2026-07-21T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

// artifact_edit_session.artifact_id → artifact.id (FK). Seed a minimal hub row.
async function seedArtifact(id: string) {
  await testDb()
    .insert(artifact)
    .values({
      id,
      type: 'note_hub',
      title: id,
      knowledge_ids: [],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      body_blocks: { type: 'doc', content: [] } as never,
      attrs: {} as never,
      generation_status: 'ready',
      verification_status: 'verified',
      history: [],
      created_at: T0,
      updated_at: T0,
      version: 0,
    })
    .onConflictDoNothing();
}

async function sessionIds(artifactId: string): Promise<string[]> {
  const rows = await testDb().execute<{ session_id: string }>(
    sql`select session_id from artifact_edit_session where artifact_id = ${artifactId} order by session_id`,
  );
  return rows.map((r) => r.session_id);
}

beforeEach(async () => {
  await resetDb();
  persistNoteRefineApply.mockClear();
});

describe('PgPresenceStore — session presence (artifact_edit_session)', () => {
  let store: PgPresenceStore;
  beforeEach(() => {
    store = new PgPresenceStore(testDb());
  });

  it('YUK-384 RED 15: blur deletes only its session and cannot clear a newer session', async () => {
    await seedArtifact('hub-a');
    await store.recordEditingHeartbeat({ artifactId: 'hub-a', sessionId: 'A' });
    await store.recordEditingHeartbeat({ artifactId: 'hub-a', sessionId: 'B' });
    await store.markArtifactIdleAndFlush({ artifactId: 'hub-a', sessionId: 'A', db: applyDb });
    expect(await sessionIds('hub-a')).toEqual(['B']);
    await store.recordEditingHeartbeat({ artifactId: 'hub-a', sessionId: 'A-new' });
    // A delayed blur for the OLD 'A' must not clear the freshly-created 'A-new'.
    await store.markArtifactIdleAndFlush({ artifactId: 'hub-a', sessionId: 'A', db: applyDb });
    expect(await sessionIds('hub-a')).toEqual(['A-new', 'B']);
  });
});

describe('PgPresenceStore — note-refine defer queue (editing_presence.pending)', () => {
  let store: PgPresenceStore;
  beforeEach(() => {
    store = new PgPresenceStore(testDb());
  });

  it('does NOT flush while another session is still editing', async () => {
    await seedArtifact('art_1');
    await store.recordEditingHeartbeat({ artifactId: 'art_1', sessionId: 'A', now: T0 });
    await store.recordEditingHeartbeat({ artifactId: 'art_1', sessionId: 'B', now: T0 });
    await store.enqueueOrApplyNoteRefinePatch({
      db: applyDb,
      artifactId: 'art_1',
      patch,
      now: at(1_000),
    });

    // Session A blurs, but B is still within the window → keep the queue.
    const flush = await store.markArtifactIdleAndFlush({
      db: applyDb,
      artifactId: 'art_1',
      sessionId: 'A',
      now: at(2_000),
    });
    expect(flush.flushed).toBe(0);
    expect(persistNoteRefineApply).not.toHaveBeenCalled();
    expect((await store.getEditingSessionSnapshot('art_1'))?.pending_patches).toBe(1);
  });

  it('YUK-384: a blur that lands between the idle-decision and the enqueue cannot orphan the patch', async () => {
    // The decision (isArtifactIdle) and the enqueue must be serialized under the SAME
    // shared advisory lock markArtifactIdleAndFlush takes; otherwise a concurrent blur
    // can drain+idle the artifact after the "not idle" read but before the append,
    // leaving the patch in a bag nobody will flush (dropped after the stale timeout).
    await seedArtifact('art_race');
    await store.recordEditingHeartbeat({ artifactId: 'art_race', sessionId: 'A', now: T0 });

    // Simulate a blur-flush in progress: hold the advisory lock and (under it) remove
    // the last session. The delete stays uncommitted until release, so a decision that
    // reads BEFORE acquiring the lock still sees the session as active.
    const held = createDeferred();
    const release = createDeferred();
    const holder = testDb().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'art_race'}, 0))`);
      await tx.execute(sql`delete from artifact_edit_session where artifact_id = 'art_race'`);
      held.resolve();
      await release.promise;
    });
    await held.promise; // lock held + session-delete staged (uncommitted)

    // Under the fix, enqueue BLOCKS on the advisory lock; the pre-fix code races ahead,
    // reads the (uncommitted-delete) session as active, and defers into an orphan bag.
    const enqueue = store.enqueueOrApplyNoteRefinePatch({
      db: applyDb,
      artifactId: 'art_race',
      patch,
      now: at(1_000),
    });
    await new Promise((r) => setTimeout(r, 200)); // let enqueue reach the lock wait

    release.resolve(); // holder commits the session delete + frees the lock
    await holder;
    const result = await enqueue;

    // Fix: enqueue reacquires the lock, re-checks idle (session now gone) and APPLIES —
    // never a silent defer into a bag the blur already abandoned.
    expect(result.status).toBe('applied');
    expect(persistNoteRefineApply).toHaveBeenCalledTimes(1);
    expect((await store.getEditingSessionSnapshot('art_race'))?.pending_patches ?? 0).toBe(0);
  });

  it('YUK-384: a heartbeat that lands between the blur decision and the drain cannot flush over an active editor', async () => {
    await seedArtifact('art_flush');
    await store.recordEditingHeartbeat({ artifactId: 'art_flush', sessionId: 'A', now: T0 });
    // Queue a patch while A is active → deferred into the pending bag.
    await store.enqueueOrApplyNoteRefinePatch({
      db: applyDb,
      artifactId: 'art_flush',
      patch,
      now: at(1_000),
    });
    expect((await store.getEditingSessionSnapshot('art_flush'))?.pending_patches).toBe(1);

    // Hold the pending-row lock so the flush's drain BLOCKS there — opening the window a
    // concurrent heartbeat exploited in the pre-fix two-transaction structure (the
    // idle-decision committed in txn1, releasing the advisory lock, before txn2 drained).
    const held = createDeferred();
    const release = createDeferred();
    const holder = testDb().transaction(async (tx) => {
      await tx.execute(
        sql`select 1 from editing_presence where artifact_id = 'art_flush' for update`,
      );
      held.resolve();
      await release.promise;
    });
    await held.promise;

    // Blur A (real clock, so the active-check window matches B's live heartbeat).
    const flushP = store.markArtifactIdleAndFlush({
      db: applyDb,
      artifactId: 'art_flush',
      sessionId: 'A',
    });
    await new Promise((r) => setTimeout(r, 200)); // let the flush reach the row-lock wait

    // A NEW session B starts editing (direct insert, committing while the flush is
    // blocked) — re-activating the artifact inside the blur→drain window.
    await testDb().execute(sql`
      insert into artifact_edit_session (artifact_id, session_id, started_at, last_heartbeat_at)
      values ('art_flush', 'B', clock_timestamp(), clock_timestamp())
    `);
    release.resolve();
    await holder;
    const flush = await flushP;

    // Fix: the drain re-checks active sessions under the lock, sees B, and does NOT flush.
    expect(flush.flushed).toBe(0);
    expect(persistNoteRefineApply).not.toHaveBeenCalled();
    expect((await store.getEditingSessionSnapshot('art_flush'))?.pending_patches).toBe(1);
  });
});

describe('PgPresenceStore — 跨进程语义 (两实例共享同一 PG)', () => {
  let storeA: PgPresenceStore;
  let storeB: PgPresenceStore;
  beforeEach(() => {
    storeA = new PgPresenceStore(testDb());
    storeB = new PgPresenceStore(testDb());
  });

  it('a patch deferred via A flushes via B once the session blurs', async () => {
    await seedArtifact('art_flush');
    await storeA.recordEditingHeartbeat({ artifactId: 'art_flush', sessionId: 'A', now: T0 });
    await storeA.enqueueOrApplyNoteRefinePatch({
      db: applyDb,
      artifactId: 'art_flush',
      patch,
      now: at(1_000),
    });

    const flush = await storeB.markArtifactIdleAndFlush({
      db: applyDb,
      artifactId: 'art_flush',
      sessionId: 'A',
      now: at(2_000),
    });
    expect(flush.flushed).toBe(1);
    expect(await storeA.isArtifactIdle('art_flush', at(2_000))).toBe(true);
  });
});

describe('PgPresenceStore — 陈旧 pending 丢弃 (裁决 i)', () => {
  let store: PgPresenceStore;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    store = new PgPresenceStore(testDb());
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('YUK-768: keeps a stale hub_auto_sync deferred patch during flush while dropping a same-aged non-hub one', async () => {
    await seedArtifact('art_hub');
    const flushAt = at(11 * 60_000); // T0 + 11min — both entries below are >10min old
    // Two same-aged (queuedAtMs = T0) stale entries: the mutation-triggered hub
    // sync patch opts out of the force-apply ceiling and must survive pruning;
    // the plain note-refine patch (no actorRef) is dropped at the TTL.
    await testDb()
      .insert(editing_presence)
      .values({
        artifact_id: 'art_hub',
        status: 'editing',
        last_heartbeat_at: at(10 * 60_000),
        editing_started_at: null,
        pending: [
          {
            patch,
            triggerEventId: null,
            queuedAtMs: T0.getTime(),
            actorRef: HUB_AUTO_SYNC_ACTOR_REF,
          },
          { patch, triggerEventId: null, queuedAtMs: T0.getTime() },
        ],
      });

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    // No active session → blur flushes. The hub_auto_sync entry survives pruning
    // and is applied; the non-hub entry is dropped (warned).
    const flush = await store.markArtifactIdleAndFlush({
      db: applyDb,
      artifactId: 'art_hub',
      sessionId: 'gone',
      now: flushAt,
    });
    expect(flush.flushed).toBe(1);
    expect(persistNoteRefineApply).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('dropped 1 stale pending patch(es)'),
    );
    // The intentional TTL exemption emits a low-severity visibility breadcrumb.
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining(`retained 1 ${HUB_AUTO_SYNC_ACTOR_REF} pending patch(es)`),
    );
  });
});
