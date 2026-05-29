import { persistNoteRefineApply } from '@/server/artifacts/note-refine-apply';
import type { PersistNoteRefineApplyResult } from '@/server/artifacts/note-refine-apply';

import {
  EDITING_FORCE_APPLY_TIMEOUT_MS,
  EDITING_HEARTBEAT_TIMEOUT_MS,
  type EditingSessionSnapshot,
  type EditingStatus,
  type EnqueueOrApplyInput,
  type EnqueueOrApplyResult,
  type MarkIdleAndFlushInput,
  type MarkIdleAndFlushResult,
  type PresenceStore,
  type QueuedPatch,
  type RecordHeartbeatInput,
} from './types';

interface EditingSessionState {
  artifactId: string;
  status: EditingStatus;
  lastHeartbeatAt: Date;
  editingStartedAt: Date | null;
  pending: QueuedPatch[];
}

function cloneDate(date: Date): Date {
  return new Date(date.getTime());
}

// Process-local presence store. This is the original editing-session.ts Map
// behavior, preserved verbatim — it is the DEFAULT for dev + the fast unit
// suite (no REDIS_URL needed). It is intentionally NOT cross-process; the Redis
// store is what makes presence shared between the web + worker processes.
export class InMemoryPresenceStore implements PresenceStore {
  private readonly sessions = new Map<string, EditingSessionState>();

  private currentState(artifactId: string, now: Date): EditingSessionState {
    const existing = this.sessions.get(artifactId);
    if (existing) return existing;
    const state: EditingSessionState = {
      artifactId,
      status: 'idle',
      lastHeartbeatAt: cloneDate(now),
      editingStartedAt: null,
      pending: [],
    };
    this.sessions.set(artifactId, state);
    return state;
  }

  async recordEditingHeartbeat(input: RecordHeartbeatInput): Promise<void> {
    const now = input.now ?? new Date();
    const state = this.currentState(input.artifactId, now);
    state.status = input.status;
    state.lastHeartbeatAt = cloneDate(now);
    state.editingStartedAt =
      input.status === 'editing' ? (state.editingStartedAt ?? cloneDate(now)) : null;
  }

  async isArtifactIdle(artifactId: string, now = new Date()): Promise<boolean> {
    const state = this.sessions.get(artifactId);
    if (!state) return true;
    if (state.status === 'idle') return true;
    if (now.getTime() - state.lastHeartbeatAt.getTime() > EDITING_HEARTBEAT_TIMEOUT_MS) {
      state.status = 'idle';
      state.editingStartedAt = null;
      return true;
    }
    return false;
  }

  private shouldForceApply(state: EditingSessionState, now: Date): boolean {
    return (
      state.status === 'editing' &&
      state.editingStartedAt !== null &&
      now.getTime() - state.editingStartedAt.getTime() >= EDITING_FORCE_APPLY_TIMEOUT_MS
    );
  }

  async enqueueOrApplyNoteRefinePatch(input: EnqueueOrApplyInput): Promise<EnqueueOrApplyResult> {
    const now = input.now ?? new Date();
    const state = this.currentState(input.artifactId, now);
    if (!(await this.isArtifactIdle(input.artifactId, now)) && !this.shouldForceApply(state, now)) {
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

  async markArtifactIdleAndFlush(input: MarkIdleAndFlushInput): Promise<MarkIdleAndFlushResult> {
    const now = input.now ?? new Date();
    const state = this.currentState(input.artifactId, now);
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

  async getEditingSessionSnapshot(artifactId: string): Promise<EditingSessionSnapshot | null> {
    const state = this.sessions.get(artifactId);
    if (!state) return null;
    return {
      artifact_id: artifactId,
      status: state.status,
      last_heartbeat_at: state.lastHeartbeatAt.toISOString(),
      pending_patches: state.pending.length,
    };
  }

  async reset(): Promise<void> {
    this.sessions.clear();
  }
}
