import type { NotePatchT } from '@/core/schema/note-patch';
import type { Db } from '@/db/client';
import type { TaskTextResult } from '@/server/ai/provenance';
import {
  type PersistNoteRefineApplyResult,
  persistNoteRefineApply,
} from '@/server/artifacts/note-refine-apply';

export const EDITING_HEARTBEAT_TIMEOUT_MS = 30_000;
export const EDITING_FORCE_APPLY_TIMEOUT_MS = 10 * 60_000;

export type EditingStatus = 'editing' | 'idle';

interface QueuedPatch {
  patch: NotePatchT;
  taskResult?: TaskTextResult;
  triggerEventId?: string | null;
  queuedAt: Date;
}

interface EditingSessionState {
  artifactId: string;
  status: EditingStatus;
  lastHeartbeatAt: Date;
  editingStartedAt: Date | null;
  pending: QueuedPatch[];
}

const sessions = new Map<string, EditingSessionState>();

function cloneDate(date: Date): Date {
  return new Date(date.getTime());
}

function currentState(artifactId: string, now: Date): EditingSessionState {
  const existing = sessions.get(artifactId);
  if (existing) return existing;
  const state: EditingSessionState = {
    artifactId,
    status: 'idle',
    lastHeartbeatAt: cloneDate(now),
    editingStartedAt: null,
    pending: [],
  };
  sessions.set(artifactId, state);
  return state;
}

export function resetEditingSessionStateForTests(): void {
  sessions.clear();
}

export function recordEditingHeartbeat(input: {
  artifactId: string;
  status: EditingStatus;
  now?: Date;
}): void {
  const now = input.now ?? new Date();
  const state = currentState(input.artifactId, now);
  state.status = input.status;
  state.lastHeartbeatAt = cloneDate(now);
  state.editingStartedAt =
    input.status === 'editing' ? (state.editingStartedAt ?? cloneDate(now)) : null;
}

export function isArtifactIdle(artifactId: string, now = new Date()): boolean {
  const state = sessions.get(artifactId);
  if (!state) return true;
  if (state.status === 'idle') return true;
  if (now.getTime() - state.lastHeartbeatAt.getTime() > EDITING_HEARTBEAT_TIMEOUT_MS) {
    state.status = 'idle';
    state.editingStartedAt = null;
    return true;
  }
  return false;
}

function shouldForceApply(state: EditingSessionState, now: Date): boolean {
  return (
    state.status === 'editing' &&
    state.editingStartedAt !== null &&
    now.getTime() - state.editingStartedAt.getTime() >= EDITING_FORCE_APPLY_TIMEOUT_MS
  );
}

export async function enqueueOrApplyNoteRefinePatch(input: {
  db: Db;
  artifactId: string;
  patch: NotePatchT;
  taskResult?: TaskTextResult;
  triggerEventId?: string | null;
  now?: Date;
}): Promise<PersistNoteRefineApplyResult | { status: 'deferred'; artifact_id: string }> {
  const now = input.now ?? new Date();
  const state = currentState(input.artifactId, now);
  if (!isArtifactIdle(input.artifactId, now) && !shouldForceApply(state, now)) {
    state.pending.push({
      patch: input.patch,
      taskResult: input.taskResult,
      triggerEventId: input.triggerEventId ?? null,
      queuedAt: cloneDate(now),
    });
    return { status: 'deferred', artifact_id: input.artifactId };
  }

  return persistNoteRefineApply({
    db: input.db,
    artifactId: input.artifactId,
    patch: input.patch,
    taskResult: input.taskResult,
    triggerEventId: input.triggerEventId ?? null,
    now,
  });
}

export async function markArtifactIdleAndFlush(input: {
  db: Db;
  artifactId: string;
  now?: Date;
}): Promise<{ artifact_id: string; flushed: number; results: PersistNoteRefineApplyResult[] }> {
  const now = input.now ?? new Date();
  const state = currentState(input.artifactId, now);
  state.status = 'idle';
  state.lastHeartbeatAt = cloneDate(now);
  state.editingStartedAt = null;
  const pending = state.pending.splice(0);
  const results: PersistNoteRefineApplyResult[] = [];
  for (const item of pending) {
    const result = await persistNoteRefineApply({
      db: input.db,
      artifactId: input.artifactId,
      patch: item.patch,
      taskResult: item.taskResult,
      triggerEventId: item.triggerEventId ?? null,
      now,
    });
    results.push(result);
  }
  return { artifact_id: input.artifactId, flushed: pending.length, results };
}

export function getEditingSessionSnapshot(artifactId: string): {
  artifact_id: string;
  status: EditingStatus;
  last_heartbeat_at: string;
  pending_patches: number;
} | null {
  const state = sessions.get(artifactId);
  if (!state) return null;
  return {
    artifact_id: artifactId,
    status: state.status,
    last_heartbeat_at: state.lastHeartbeatAt.toISOString(),
    pending_patches: state.pending.length,
  };
}
