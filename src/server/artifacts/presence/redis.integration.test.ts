import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NotePatchT } from '@/core/schema/note-patch';

import { InMemoryPresenceStore } from './in-memory';
import { RedisPresenceStore } from './redis';

// The DB write side effect is irrelevant to the cross-process presence
// question — mock it so this test exercises only the shared-state behavior.
vi.mock('@/capabilities/notes/server/note-refine-apply', () => ({
  persistNoteRefineApply: vi.fn(async (args: { artifactId: string }) => ({
    status: 'applied' as const,
    artifact_id: args.artifactId,
  })),
}));

const patch = { ops: [{ kind: 'append_block', block: {} }] } as unknown as NotePatchT;
const db = {} as never;

// This is the actual YUK-148 regression. The Next web process and the pg-boss
// worker process are separate; before the fix they each held a process-local
// Map, so the worker saw the user's active edit as "idle". Here we simulate the
// two processes as two SEPARATE PresenceStore instances. Redis (shared backend)
// must let instance B observe a heartbeat recorded by instance A; the in-memory
// store must NOT (proving the old code's bug).
describe('cross-process editing presence (YUK-148)', () => {
  let container: StartedRedisContainer;
  // Two clients pointing at the SAME Redis url — "web" + "worker".
  let redisA: Redis;
  let redisB: Redis;
  let storeA: RedisPresenceStore;
  let storeB: RedisPresenceStore;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();
    const url = container.getConnectionUrl();
    redisA = new Redis(url);
    redisB = new Redis(url);
    storeA = new RedisPresenceStore(redisA);
    storeB = new RedisPresenceStore(redisB);
  }, 60_000);

  afterAll(async () => {
    await redisA?.quit();
    await redisB?.quit();
    await container?.stop();
  });

  beforeEach(async () => {
    await storeA.reset();
  });

  it('instance B sees an editing heartbeat recorded by instance A (presence is shared)', async () => {
    const now = new Date('2026-05-30T12:00:00.000Z');
    // "web" process records the user actively editing.
    await storeA.recordEditingHeartbeat({ artifactId: 'art_shared', status: 'editing', now });

    // "worker" process — a DIFFERENT instance — must NOT see idle, so it defers
    // its AI patch instead of clobbering the live edit.
    expect(await storeB.isArtifactIdle('art_shared', now)).toBe(false);

    const decision = await storeB.enqueueOrApplyNoteRefinePatch({
      db,
      artifactId: 'art_shared',
      patch,
      now: new Date(now.getTime() + 1_000),
    });
    expect(decision).toEqual({ status: 'deferred', artifact_id: 'art_shared' });
  });

  it('the deferred patch enqueued via A flushes via B once the session goes idle', async () => {
    const now = new Date('2026-05-30T12:00:00.000Z');
    await storeA.recordEditingHeartbeat({ artifactId: 'art_flush', status: 'editing', now });
    await storeA.enqueueOrApplyNoteRefinePatch({
      db,
      artifactId: 'art_flush',
      patch,
      now: new Date(now.getTime() + 1_000),
    });

    // Worker instance flushes; it must observe the patch A enqueued.
    const flush = await storeB.markArtifactIdleAndFlush({
      db,
      artifactId: 'art_flush',
      now: new Date(now.getTime() + 2_000),
    });
    expect(flush.flushed).toBe(1);
    expect(await storeA.isArtifactIdle('art_flush', new Date(now.getTime() + 2_000))).toBe(true);
  });

  // Control: the OLD behavior. Two in-memory stores are independent — this is
  // exactly the cross-process bug the Redis impl fixes. If this ever started
  // sharing, the in-memory store would have grown unexpected global state.
  it('two in-memory stores do NOT share presence (demonstrates the pre-fix bug)', async () => {
    const now = new Date('2026-05-30T12:00:00.000Z');
    const memA = new InMemoryPresenceStore();
    const memB = new InMemoryPresenceStore();
    await memA.recordEditingHeartbeat({ artifactId: 'art_iso', status: 'editing', now });
    // memA sees the edit...
    expect(await memA.isArtifactIdle('art_iso', now)).toBe(false);
    // ...but memB (the "other process") wrongly thinks it's idle.
    expect(await memB.isArtifactIdle('art_iso', now)).toBe(true);
  });
});
