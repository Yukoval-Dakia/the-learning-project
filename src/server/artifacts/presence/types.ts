import type { PersistNoteRefineApplyResult } from '@/capabilities/notes/server/note-refine-apply';
import type { NotePatchT } from '@/core/schema/note-patch';
import type { Db } from '@/db/client';
import type { TaskTextResult } from '@/server/ai/provenance';

// How long a recorded `editing` heartbeat stays "live" before isArtifactIdle
// flips the session to idle. The Redis store also uses this as the per-artifact
// key TTL so stale presence self-expires (a missing/expired key reads as idle).
export const EDITING_HEARTBEAT_TIMEOUT_MS = 30_000;
// Ceiling on how long an actively-edited artifact can defer an AI patch before
// it is force-applied anyway.
export const EDITING_FORCE_APPLY_TIMEOUT_MS = 10 * 60_000;

export type EditingStatus = 'editing' | 'idle';

// A note-refine patch deferred while the artifact is actively edited, to be
// flushed in FIFO order once the session goes idle. Dates are carried as ISO
// strings in the Redis serialization; the in-memory store keeps Date objects.
export interface QueuedPatch {
  patch: NotePatchT;
  taskResult?: TaskTextResult;
  triggerEventId?: string | null;
  queuedAt: Date;
}

export interface EditingSessionSnapshot {
  artifact_id: string;
  status: EditingStatus;
  last_heartbeat_at: string;
  pending_patches: number;
}

export interface RecordHeartbeatInput {
  artifactId: string;
  status: EditingStatus;
  now?: Date;
}

export interface EnqueueOrApplyInput {
  db: Db;
  artifactId: string;
  patch: NotePatchT;
  taskResult?: TaskTextResult;
  triggerEventId?: string | null;
  now?: Date;
}

export type EnqueueOrApplyResult =
  | PersistNoteRefineApplyResult
  | { status: 'deferred'; artifact_id: string };

export interface MarkIdleAndFlushInput {
  db: Db;
  artifactId: string;
  now?: Date;
}

export interface MarkIdleAndFlushResult {
  artifact_id: string;
  flushed: number;
  results: PersistNoteRefineApplyResult[];
}

// Cross-process editing presence (YUK-148 / ADR-0023). Two concrete impls:
//   - InMemoryPresenceStore  — process-local Map; default for dev + fast unit tests.
//   - RedisPresenceStore     — shared across web + worker processes when REDIS_URL set.
// Both preserve EXACT current semantics of the original editing-session.ts state
// machine (encoded by editing-session.test.ts). All reads/writes are async to
// accommodate Redis I/O; the in-memory impl resolves synchronously.
export interface PresenceStore {
  // Record a heartbeat. Stamps editingStartedAt only on the FIRST editing
  // heartbeat (so the force-apply clock isn't reset by subsequent heartbeats);
  // clears it on idle.
  recordEditingHeartbeat(input: RecordHeartbeatInput): Promise<void>;

  // Returns true if the artifact is idle. STICKY: an editing session whose last
  // heartbeat exceeded EDITING_HEARTBEAT_TIMEOUT_MS is transitioned to idle as a
  // side effect. A never-seen / expired artifact reads as idle (safe default).
  isArtifactIdle(artifactId: string, now?: Date): Promise<boolean>;

  // Apply the patch immediately when the artifact is idle (or past the
  // force-apply ceiling); otherwise enqueue it for later flush. The actual DB
  // write (persistNoteRefineApply) happens outside any atomic section.
  enqueueOrApplyNoteRefinePatch(input: EnqueueOrApplyInput): Promise<EnqueueOrApplyResult>;

  // Mark the artifact idle and flush all pending patches in FIFO order.
  markArtifactIdleAndFlush(input: MarkIdleAndFlushInput): Promise<MarkIdleAndFlushResult>;

  // Snapshot of the current session, or null if none recorded.
  getEditingSessionSnapshot(artifactId: string): Promise<EditingSessionSnapshot | null>;

  // Clear all presence state — test helper.
  reset(): Promise<void>;
}
