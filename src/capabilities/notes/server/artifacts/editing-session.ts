import { db } from '@/db/client';
import { PgPresenceStore } from './presence/pg';
import type {
  EditingSessionSnapshot,
  EnqueueOrApplyInput,
  EnqueueOrApplyResult,
  MarkIdleAndFlushInput,
  MarkIdleAndFlushResult,
  PresenceStore,
  RecordHeartbeatInput,
} from './presence/types';

// Keep one store over the shared DB pool; persisted presence is shared across
// processes even though this store instance is local to the process.
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
