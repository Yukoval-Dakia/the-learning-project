import { db } from '@/db/client';
import { PgPresenceStore } from '@/server/artifacts/presence/pg';
import type {
  EditingSessionSnapshot,
  EnqueueOrApplyInput,
  EnqueueOrApplyResult,
  MarkIdleAndFlushInput,
  MarkIdleAndFlushResult,
  PresenceStore,
  RecordHeartbeatInput,
} from '@/server/artifacts/presence/types';

export {
  EDITING_FORCE_APPLY_TIMEOUT_MS,
  EDITING_HEARTBEAT_TIMEOUT_MS,
  type EditingStatus,
} from '@/server/artifacts/presence/types';

// Presence is process-wide, so the store is a lazy singleton over the shared
// PG pool; creating one per call would open connections needlessly.
let store: PresenceStore | undefined;

function getPresenceStore(): PresenceStore {
  store ??= new PgPresenceStore(db);
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

// Unit suites mock the store to an in-memory implementation; DB suites clear the
// editing_presence table.
export function resetEditingSessionStateForTests(): Promise<void> {
  return getPresenceStore().reset();
}
