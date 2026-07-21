import { persistNoteRefineApply } from '@/capabilities/notes/server/note-refine-apply';
import type { PersistNoteRefineApplyResult } from '@/capabilities/notes/server/note-refine-apply';

import {
  EDITING_FORCE_APPLY_TIMEOUT_MS,
  EDITING_HEARTBEAT_TIMEOUT_MS,
  type EditingSessionSnapshot,
  type EnqueueOrApplyInput,
  type EnqueueOrApplyResult,
  type MarkIdleAndFlushInput,
  type MarkIdleAndFlushResult,
  type PresenceStore,
  type QueuedPatch,
  type RecordHeartbeatInput,
} from './types';

// Process-local presence store — the DEFAULT for dev + the fast unit suite
// (which vi.mock's presence/pg to this). YUK-384: observably equivalent to
// PgPresenceStore for session rows — sessions are keyed by (artifactId,
// sessionId), a session is active while its last heartbeat is within
// EDITING_HEARTBEAT_TIMEOUT_MS, and the note-refine defer queue is per-artifact.
// Intentionally NOT cross-process (the PG store is what shares state).
export class InMemoryPresenceStore implements PresenceStore {
  private readonly sessions = new Map<string, Map<string, Date>>();
  private readonly pending = new Map<string, QueuedPatch[]>();

  private sessionMap(artifactId: string): Map<string, Date> {
    let map = this.sessions.get(artifactId);
    if (!map) {
      map = new Map();
      this.sessions.set(artifactId, map);
    }
    return map;
  }

  private hasActiveSession(artifactId: string, now: Date): boolean {
    const map = this.sessions.get(artifactId);
    if (!map) return false;
    for (const lastHeartbeat of map.values()) {
      if (now.getTime() - lastHeartbeat.getTime() <= EDITING_HEARTBEAT_TIMEOUT_MS) return true;
    }
    return false;
  }

  async recordEditingHeartbeat(input: RecordHeartbeatInput): Promise<void> {
    const now = input.now ?? new Date();
    this.sessionMap(input.artifactId).set(input.sessionId, new Date(now.getTime()));
  }

  async isArtifactIdle(artifactId: string, now = new Date()): Promise<boolean> {
    return !this.hasActiveSession(artifactId, now);
  }

  async enqueueOrApplyNoteRefinePatch(input: EnqueueOrApplyInput): Promise<EnqueueOrApplyResult> {
    const now = input.now ?? new Date();
    if (this.hasActiveSession(input.artifactId, now)) {
      const queue = this.pending.get(input.artifactId) ?? [];
      const fresh = queue.filter(
        (item) => now.getTime() - item.queuedAt.getTime() <= EDITING_FORCE_APPLY_TIMEOUT_MS,
      );
      fresh.push({
        patch: input.patch,
        taskResult: input.taskResult,
        triggerEventId: input.triggerEventId ?? null,
        queuedAt: new Date(now.getTime()),
      });
      this.pending.set(input.artifactId, fresh);
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
    this.sessions.get(input.artifactId)?.delete(input.sessionId);
    if (this.hasActiveSession(input.artifactId, now)) {
      return { artifact_id: input.artifactId, flushed: 0, results: [] };
    }

    const queue = this.pending.get(input.artifactId) ?? [];
    const fresh = queue.filter(
      (item) => now.getTime() - item.queuedAt.getTime() <= EDITING_FORCE_APPLY_TIMEOUT_MS,
    );
    this.pending.set(input.artifactId, []);
    const results: PersistNoteRefineApplyResult[] = [];
    for (const item of fresh) {
      results.push(
        await persistNoteRefineApply({
          db: input.db,
          artifactId: input.artifactId,
          patch: item.patch,
          taskResult: item.taskResult,
          triggerEventId: item.triggerEventId ?? null,
          now,
        }),
      );
    }
    return { artifact_id: input.artifactId, flushed: fresh.length, results };
  }

  async getEditingSessionSnapshot(artifactId: string): Promise<EditingSessionSnapshot | null> {
    const map = this.sessions.get(artifactId);
    const pending = this.pending.get(artifactId) ?? [];
    // Parity with PgPresenceStore: a drained pending bag (the row/entry still
    // exists) reports pending_patches: 0 rather than vanishing to null.
    if ((!map || map.size === 0) && !this.pending.has(artifactId)) return null;
    const heartbeats = map ? [...map.values()] : [];
    const latest = heartbeats.reduce<Date | null>(
      (acc, d) => (acc === null || d.getTime() > acc.getTime() ? d : acc),
      null,
    );
    return {
      artifact_id: artifactId,
      // Existence-based (informational): any live session row reads as editing.
      // isArtifactIdle is the load-bearing windowed check.
      status: heartbeats.length > 0 ? 'editing' : 'idle',
      last_heartbeat_at: (latest ?? new Date()).toISOString(),
      pending_patches: pending.length,
    };
  }

  async reset(): Promise<void> {
    this.sessions.clear();
    this.pending.clear();
  }
}
