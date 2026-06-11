// YUK-171 — fail-safe degradation for RedisPresenceStore on a Redis CONNECTION
// failure (ADR-0023 "lost presence safely reads as idle" extended to ioredis
// errors). Pure unit test: a MOCKED ioredis client whose custom commands all
// reject, plus a vi.mock'd persistNoteRefineApply so no live DB / Redis is
// touched. Asserts each method degrades to its safe default instead of throwing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RedisPresenceStore } from './redis';
import type { EnqueueOrApplyInput, RecordHeartbeatInput } from './types';

// The Redis store's only DB side effect. Mock it so the apply path resolves
// without a live Postgres connection and we can assert it WAS called on degrade.
const persistNoteRefineApplyMock = vi.fn();
vi.mock('@/capabilities/notes/server/note-refine-apply', () => ({
  persistNoteRefineApply: (...args: unknown[]) => persistNoteRefineApplyMock(...args),
}));

// A fake ioredis whose presence* custom commands (defined at runtime via
// defineCommand) all reject — simulating connection refused / timeout / command
// error. defineCommand is a no-op here; scanStream/del are unused by these paths.
function makeFailingRedis() {
  const rejector = vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379'));
  return {
    defineCommand: vi.fn(),
    presenceHeartbeat: rejector,
    presenceIdleCheck: rejector,
    presenceDecide: rejector,
    presenceFlush: rejector,
    presenceSnapshot: rejector,
  };
}

describe('RedisPresenceStore — fail-safe degradation on Redis failure (YUK-171)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    persistNoteRefineApplyMock.mockReset();
    persistNoteRefineApplyMock.mockResolvedValue({
      status: 'applied',
      artifact_id: 'art1',
      ops_count: 1,
      new_blocks: 0,
      event_id: 'ev1',
      artifact_version: 1,
    });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  // vitest 4: the per-test `vi.spyOn(console, 'warn')` is no longer implicitly
  // restored between tests (vitest 2 cleaned it up under the hood), so without an
  // explicit restore each new spy wraps the previous one and `warn` call counts
  // accumulate across tests (1 → 3 → 4 → 5). Restore after every test so each
  // assertion sees only its own single warn. (restoreMocks default stays false.)
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function store() {
    return new RedisPresenceStore(makeFailingRedis() as never);
  }

  it('isArtifactIdle → returns true (idle) and warns, never throws', async () => {
    const result = await store().isArtifactIdle('art1');
    expect(result).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('recordEditingHeartbeat → resolves (no-op) and warns, never throws', async () => {
    const input: RecordHeartbeatInput = { artifactId: 'art1', status: 'editing' };
    await expect(store().recordEditingHeartbeat(input)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('getEditingSessionSnapshot → returns null and warns, never throws', async () => {
    const result = await store().getEditingSessionSnapshot('art1');
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('enqueueOrApplyNoteRefinePatch → degrades to APPLY (persist IS called), never drops the patch', async () => {
    const input = {
      db: {} as never,
      artifactId: 'art1',
      patch: { ops: [] },
      triggerEventId: 'trig1',
    } satisfies EnqueueOrApplyInput;

    const result = await store().enqueueOrApplyNoteRefinePatch(input);

    // DECIDE failed → degraded to apply → persistNoteRefineApply ran (NOT dropped).
    expect(persistNoteRefineApplyMock).toHaveBeenCalledTimes(1);
    expect(persistNoteRefineApplyMock).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: 'art1', triggerEventId: 'trig1' }),
    );
    expect(result).toMatchObject({ status: 'applied' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('markArtifactIdleAndFlush → returns { flushed: 0 } and warns, never throws or applies arbitrary items', async () => {
    const result = await store().markArtifactIdleAndFlush({ db: {} as never, artifactId: 'art1' });
    expect(result).toEqual({ artifact_id: 'art1', flushed: 0, results: [] });
    // No authoritative drained list → must NOT have applied anything.
    expect(persistNoteRefineApplyMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
