import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NotePatchT } from '@/core/schema/note-patch';

// editing-session enqueues/applies via persistNoteRefineApply. We mock that
// DB-touching dependency so the state machine (heartbeat / idle
// timeout / force-apply / defer-and-flush) can be exercised as a fast unit
// test without a live Postgres. (YUK-97 P7)
//
// M5-T5c (YUK-321): editing-session façade now always uses PgPresenceStore (which
// imports @/db/client). We mock both @/db/client (prevents module-load throw) and
// presence/pg (swaps in InMemoryPresenceStore as the test double) so the unit
// suite stays no-DB. The PgPresenceStore DB-path is exercised by pg.db.test.ts.
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/server/artifacts/presence/pg', async () => {
  const mod = await import('@/server/artifacts/presence/in-memory');
  return { PgPresenceStore: mod.InMemoryPresenceStore };
});

const persistNoteRefineApply = vi.fn(async (args: { artifactId: string }) => ({
  status: 'applied' as const,
  artifact_id: args.artifactId,
}));

vi.mock('@/capabilities/notes/server/note-refine-apply', () => ({
  persistNoteRefineApply: (args: { artifactId: string }) => persistNoteRefineApply(args),
}));

import {
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

// YUK-384 — session-qualified editing presence (in-memory contract mirror of
// PgPresenceStore). A session is active while its last heartbeat is within
// EDITING_HEARTBEAT_TIMEOUT_MS; the note-refine defer queue flushes only once the
// last session blurs. There is no force-apply-while-editing path.
const SID = 'A';

describe('isArtifactIdle', () => {
  it('treats an artifact with no recorded session as idle', async () => {
    expect(await isArtifactIdle('art_unknown', T0)).toBe(true);
  });

  it('returns false while a fresh session heartbeat is within the window', async () => {
    await recordEditingHeartbeat({ artifactId: 'art_1', sessionId: SID, now: T0 });
    expect(await isArtifactIdle('art_1', at(EDITING_HEARTBEAT_TIMEOUT_MS - 1))).toBe(false);
  });

  it('reads idle once the session heartbeat expires (exactly 30s active, >30s idle)', async () => {
    await recordEditingHeartbeat({ artifactId: 'art_1', sessionId: SID, now: T0 });
    expect(await isArtifactIdle('art_1', at(EDITING_HEARTBEAT_TIMEOUT_MS))).toBe(false);
    expect(await isArtifactIdle('art_1', at(EDITING_HEARTBEAT_TIMEOUT_MS + 1))).toBe(true);
  });
});

describe('recordEditingHeartbeat', () => {
  it('keeps one row per session and refreshes its heartbeat', async () => {
    await recordEditingHeartbeat({ artifactId: 'art_1', sessionId: SID, now: T0 });
    await recordEditingHeartbeat({ artifactId: 'art_1', sessionId: SID, now: at(5_000) });
    // Still one active session; the refreshed heartbeat keeps it active past T0+30s.
    expect(await isArtifactIdle('art_1', at(5_000 + EDITING_HEARTBEAT_TIMEOUT_MS - 1))).toBe(false);
  });
});

describe('enqueueOrApplyNoteRefinePatch', () => {
  it('applies immediately when no session is active', async () => {
    const result = await enqueueOrApplyNoteRefinePatch({ db, artifactId: 'art_1', patch, now: T0 });
    expect(result.status).toBe('applied');
    expect(persistNoteRefineApply).toHaveBeenCalledTimes(1);
  });

  it('defers the patch while a session is actively editing', async () => {
    await recordEditingHeartbeat({ artifactId: 'art_1', sessionId: SID, now: T0 });
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
});

describe('markArtifactIdleAndFlush', () => {
  it('flushes queued patches in order once the last session blurs', async () => {
    await recordEditingHeartbeat({ artifactId: 'art_1', sessionId: SID, now: T0 });
    await enqueueOrApplyNoteRefinePatch({ db, artifactId: 'art_1', patch, now: at(1_000) });
    await enqueueOrApplyNoteRefinePatch({ db, artifactId: 'art_1', patch, now: at(2_000) });
    expect(persistNoteRefineApply).not.toHaveBeenCalled();

    const flush = await markArtifactIdleAndFlush({
      db,
      artifactId: 'art_1',
      sessionId: SID,
      now: at(3_000),
    });
    expect(flush.flushed).toBe(2);
    expect(flush.results).toHaveLength(2);
    expect(persistNoteRefineApply).toHaveBeenCalledTimes(2);
    expect((await getEditingSessionSnapshot('art_1'))?.pending_patches).toBe(0);
    expect(await isArtifactIdle('art_1', at(3_000))).toBe(true);
  });

  it('does NOT flush while another session is still editing', async () => {
    await recordEditingHeartbeat({ artifactId: 'art_1', sessionId: 'A', now: T0 });
    await recordEditingHeartbeat({ artifactId: 'art_1', sessionId: 'B', now: T0 });
    await enqueueOrApplyNoteRefinePatch({ db, artifactId: 'art_1', patch, now: at(1_000) });

    const flush = await markArtifactIdleAndFlush({
      db,
      artifactId: 'art_1',
      sessionId: 'A',
      now: at(2_000),
    });
    expect(flush.flushed).toBe(0);
    expect(persistNoteRefineApply).not.toHaveBeenCalled();
    expect((await getEditingSessionSnapshot('art_1'))?.pending_patches).toBe(1);
  });

  it('is a no-op flush when there are no pending patches', async () => {
    const flush = await markArtifactIdleAndFlush({
      db,
      artifactId: 'art_idle',
      sessionId: SID,
      now: T0,
    });
    expect(flush.flushed).toBe(0);
    expect(persistNoteRefineApply).not.toHaveBeenCalled();
  });
});

describe('getEditingSessionSnapshot', () => {
  it('returns null for an artifact that has never had a session', async () => {
    expect(await getEditingSessionSnapshot('art_none')).toBeNull();
  });

  it('exposes derived status, heartbeat time, and pending count for an active session', async () => {
    await recordEditingHeartbeat({ artifactId: 'art_1', sessionId: SID, now: T0 });
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
