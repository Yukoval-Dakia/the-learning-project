import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NotePatchT } from '@/core/schema/note-patch';

// editing-session enqueues/applies via persistNoteRefineApply. We mock that
// DB-touching dependency so the in-memory state machine (heartbeat / idle
// timeout / force-apply / defer-and-flush) can be exercised as a fast unit
// test without a live Postgres. (YUK-97 P7)
//
// No REDIS_URL is set in this suite, so the editing-session façade selects the
// in-memory PresenceStore — this stays a fast, no-DB, cross-process-free unit
// test. (YUK-148: the Redis impl is exercised by the db-partition integration
// test redis.integration.test.ts.)
const persistNoteRefineApply = vi.fn(async (args: { artifactId: string }) => ({
  status: 'applied' as const,
  artifact_id: args.artifactId,
}));

vi.mock('@/server/artifacts/note-refine-apply', () => ({
  persistNoteRefineApply: (args: { artifactId: string }) => persistNoteRefineApply(args),
}));

import {
  EDITING_FORCE_APPLY_TIMEOUT_MS,
  EDITING_HEARTBEAT_TIMEOUT_MS,
  enqueueOrApplyNoteRefinePatch,
  getEditingSessionSnapshot,
  isArtifactIdle,
  markArtifactIdleAndFlush,
  recordEditingHeartbeat,
  resetEditingSessionStateForTests,
} from '@/server/artifacts/editing-session';

// Opaque patch — the state machine never inspects ops; it forwards the patch
// to the (mocked) persist fn. A single op keeps it out of the empty-patch path.
const patch = { ops: [{ kind: 'append_block', block: {} }] } as unknown as NotePatchT;
const db = {} as never;
const T0 = new Date('2026-05-28T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

beforeEach(async () => {
  await resetEditingSessionStateForTests();
  persistNoteRefineApply.mockClear();
});

describe('isArtifactIdle', () => {
  it('treats an artifact with no recorded session as idle', async () => {
    expect(await isArtifactIdle('art_unknown', T0)).toBe(true);
  });

  it('returns false while a fresh editing heartbeat is within the timeout window', async () => {
    await recordEditingHeartbeat({ artifactId: 'art_1', status: 'editing', now: T0 });
    expect(await isArtifactIdle('art_1', at(EDITING_HEARTBEAT_TIMEOUT_MS - 1))).toBe(false);
  });

  it('auto-transitions an editing artifact to idle once the heartbeat times out', async () => {
    await recordEditingHeartbeat({ artifactId: 'art_1', status: 'editing', now: T0 });
    expect(await isArtifactIdle('art_1', at(EDITING_HEARTBEAT_TIMEOUT_MS + 1))).toBe(true);
    // The transition is sticky: the snapshot now reads idle.
    expect((await getEditingSessionSnapshot('art_1'))?.status).toBe('idle');
  });

  it('returns true immediately for an explicitly idle heartbeat', async () => {
    await recordEditingHeartbeat({ artifactId: 'art_1', status: 'idle', now: T0 });
    expect(await isArtifactIdle('art_1', T0)).toBe(true);
  });
});

describe('recordEditingHeartbeat', () => {
  it('stamps editingStartedAt only on the first editing heartbeat and clears it on idle', async () => {
    await recordEditingHeartbeat({ artifactId: 'art_1', status: 'editing', now: T0 });
    // A second editing heartbeat must not reset the force-apply clock: the
    // patch applied below would otherwise never reach the force-apply window.
    await recordEditingHeartbeat({ artifactId: 'art_1', status: 'editing', now: at(5_000) });
    expect(await isArtifactIdle('art_1', at(5_000))).toBe(false);

    await recordEditingHeartbeat({ artifactId: 'art_1', status: 'idle', now: at(6_000) });
    expect(await isArtifactIdle('art_1', at(6_000))).toBe(true);
  });
});

describe('enqueueOrApplyNoteRefinePatch', () => {
  it('applies immediately when the artifact is idle', async () => {
    const result = await enqueueOrApplyNoteRefinePatch({
      db,
      artifactId: 'art_1',
      patch,
      now: T0,
    });
    expect(result.status).toBe('applied');
    expect(persistNoteRefineApply).toHaveBeenCalledTimes(1);
  });

  it('defers the patch while the artifact is actively being edited', async () => {
    await recordEditingHeartbeat({ artifactId: 'art_1', status: 'editing', now: T0 });
    const result = await enqueueOrApplyNoteRefinePatch({
      db,
      artifactId: 'art_1',
      patch,
      now: at(1_000),
    });
    expect(result).toEqual({ status: 'deferred', artifact_id: 'art_1' });
    expect(persistNoteRefineApply).not.toHaveBeenCalled();
    expect((await getEditingSessionSnapshot('art_1'))?.pending_patches).toBe(1);
  });

  it('force-applies a patch once editing exceeds the force-apply timeout', async () => {
    await recordEditingHeartbeat({ artifactId: 'art_1', status: 'editing', now: T0 });
    // Keep the heartbeat alive so isArtifactIdle does not short-circuit; the
    // editing session has now been open past the force-apply ceiling.
    await recordEditingHeartbeat({
      artifactId: 'art_1',
      status: 'editing',
      now: at(EDITING_FORCE_APPLY_TIMEOUT_MS),
    });
    const result = await enqueueOrApplyNoteRefinePatch({
      db,
      artifactId: 'art_1',
      patch,
      now: at(EDITING_FORCE_APPLY_TIMEOUT_MS),
    });
    expect(result.status).toBe('applied');
    expect(persistNoteRefineApply).toHaveBeenCalledTimes(1);
  });
});

describe('markArtifactIdleAndFlush', () => {
  it('flushes queued patches in order and reports the flushed count', async () => {
    await recordEditingHeartbeat({ artifactId: 'art_1', status: 'editing', now: T0 });
    await enqueueOrApplyNoteRefinePatch({ db, artifactId: 'art_1', patch, now: at(1_000) });
    await enqueueOrApplyNoteRefinePatch({ db, artifactId: 'art_1', patch, now: at(2_000) });
    expect(persistNoteRefineApply).not.toHaveBeenCalled();

    const flush = await markArtifactIdleAndFlush({ db, artifactId: 'art_1', now: at(3_000) });
    expect(flush.flushed).toBe(2);
    expect(flush.results).toHaveLength(2);
    expect(persistNoteRefineApply).toHaveBeenCalledTimes(2);
    // Queue is drained and the session is idle afterward.
    expect((await getEditingSessionSnapshot('art_1'))?.pending_patches).toBe(0);
    expect(await isArtifactIdle('art_1', at(3_000))).toBe(true);
  });

  it('is a no-op flush when there are no pending patches', async () => {
    const flush = await markArtifactIdleAndFlush({ db, artifactId: 'art_idle', now: T0 });
    expect(flush.flushed).toBe(0);
    expect(persistNoteRefineApply).not.toHaveBeenCalled();
  });
});

describe('getEditingSessionSnapshot', () => {
  it('returns null for an artifact that has never had a session', async () => {
    expect(await getEditingSessionSnapshot('art_none')).toBeNull();
  });

  it('exposes status, heartbeat time, and pending count for an active session', async () => {
    await recordEditingHeartbeat({ artifactId: 'art_1', status: 'editing', now: T0 });
    await enqueueOrApplyNoteRefinePatch({ db, artifactId: 'art_1', patch, now: at(1_000) });
    const snapshot = await getEditingSessionSnapshot('art_1');
    expect(snapshot).toEqual({
      artifact_id: 'art_1',
      status: 'editing',
      last_heartbeat_at: T0.toISOString(),
      pending_patches: 1,
    });
  });
});
