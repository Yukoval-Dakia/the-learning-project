import { getRedis } from '@/server/redis/client';

import { InMemoryPresenceStore } from './presence/in-memory';
import { RedisPresenceStore } from './presence/redis';
import type {
  EditingSessionSnapshot,
  EnqueueOrApplyInput,
  EnqueueOrApplyResult,
  MarkIdleAndFlushInput,
  MarkIdleAndFlushResult,
  PresenceStore,
  RecordHeartbeatInput,
} from './presence/types';

export {
  EDITING_FORCE_APPLY_TIMEOUT_MS,
  EDITING_HEARTBEAT_TIMEOUT_MS,
  type EditingStatus,
} from './presence/types';

// Editing presence is cross-process (web + worker) when REDIS_URL is set, and
// process-local (in-memory Map) otherwise — the dev + fast-unit-test default.
// See ADR-0023 and docs/superpowers/plans/2026-05-30-yuk148-redis-lane.md.
//
// Lazy singleton: the store is selected once by REDIS_URL presence and reused
// for the life of the process. Don't open a Redis connection per call.
let store: PresenceStore | undefined;

function getPresenceStore(): PresenceStore {
  if (store) return store;
  store = process.env.REDIS_URL ? new RedisPresenceStore(getRedis()) : new InMemoryPresenceStore();
  return store;
}

export function recordEditingHeartbeat(input: RecordHeartbeatInput): Promise<void> {
  return getPresenceStore().recordEditingHeartbeat(input);
}

export function isArtifactIdle(artifactId: string, now?: Date): Promise<boolean> {
  return getPresenceStore().isArtifactIdle(artifactId, now);
}

export function enqueueOrApplyNoteRefinePatch(
  input: EnqueueOrApplyInput,
): Promise<EnqueueOrApplyResult> {
  return getPresenceStore().enqueueOrApplyNoteRefinePatch(input);
}

export function markArtifactIdleAndFlush(
  input: MarkIdleAndFlushInput,
): Promise<MarkIdleAndFlushResult> {
  return getPresenceStore().markArtifactIdleAndFlush(input);
}

export function getEditingSessionSnapshot(
  artifactId: string,
): Promise<EditingSessionSnapshot | null> {
  return getPresenceStore().getEditingSessionSnapshot(artifactId);
}

// Resets whichever impl is active. The fast unit suite has no REDIS_URL, so this
// clears the in-memory Map; an integration test with REDIS_URL clears the Redis
// namespace.
export function resetEditingSessionStateForTests(): Promise<void> {
  return getPresenceStore().reset();
}
