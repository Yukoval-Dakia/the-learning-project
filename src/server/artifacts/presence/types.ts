import type { TaskTextResult } from '@/ai/task-result';
import type { PersistNoteRefineApplyResult } from '@/capabilities/notes/public';
import type { NoteRefineApplyError } from '@/core/blocks/apply-note-patch';
import type { NotePatchT } from '@/core/schema/note-patch';
import type { Db } from '@/db/client';

// Editing presence is session-qualified: one `artifact_edit_session` row per
// (artifact, editor session). A session is ACTIVE while its last heartbeat is within
// this window; exactly-30s is still active, only age > 30s expires. There is no
// 10-minute forced apply — an abandoned session simply expires after this window
// and its work applies then.
export const EDITING_HEARTBEAT_TIMEOUT_MS = 30_000;
// Stale-pending TTL: a deferred note-refine patch older than this is dropped at
// load time (the queue never self-expires). NOT a force-apply-while-editing path.
export const EDITING_FORCE_APPLY_TIMEOUT_MS = 10 * 60_000;

// Provenance actor of a mutation-triggered hub sync. Single source of truth for
// the literal within the presence module (the guard in pg.ts and its regression
// test). Mirrors the `editing_presence.actor_ref` schema default/check and
// hub-sync-reconciliation's private ACTOR_REF; those are not wired through this
// import to avoid a capability→presence / schema→app coupling.
export const HUB_AUTO_SYNC_ACTOR_REF = 'hub_auto_sync';

export type EditingStatus = 'editing' | 'idle';

// A note-refine patch deferred while the artifact is actively edited, flushed in
// FIFO order once the session goes idle.
export interface QueuedPatch {
  patch: NotePatchT;
  taskResult?: TaskTextResult;
  triggerEventId?: string | null;
  queuedAt: Date;
}

interface QueuedPatchData {
  patch: unknown;
  taskResult?: unknown;
  triggerEventId: string | null;
  queuedAtMs: number;
  // Provenance actor of the deferred patch (`event.actor_ref` semantics). Absent
  // for the default note-refine mutator. A mutation-triggered hub sync opts out of
  // the generic force-apply ceiling, so its deferred patch must survive stale-pending
  // pruning instead of being dropped at the TTL like an abandoned note-refine patch.
  actorRef?: string;
}

export type NoteRefineQueueEntry = QueuedPatchData &
  (
    | { state: 'pending' }
    | { state: 'draining' }
    | {
        state: 'dead';
        failure: { code: NoteRefineApplyError['code']; message: string; failedAtMs: number };
      }
  );

// Historical JSON may predate queue state; reading it must not lose an already
// admitted drain obligation.
export type SerializedQueuedPatch =
  | NoteRefineQueueEntry
  | (QueuedPatchData & { state?: undefined; drainStarted?: true });

export interface EditingSessionSnapshot {
  artifact_id: string;
  status: EditingStatus;
  last_heartbeat_at: string;
  pending_patches: number;
}

export interface RecordHeartbeatInput {
  artifactId: string;
  sessionId: string;
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
  // The blurring editor session. Only this session's row is removed; the
  // deferred note-refine queue flushes only once NO active session remains.
  sessionId: string;
  now?: Date;
}

export interface MarkIdleAndFlushResult {
  artifact_id: string;
  flushed: number;
  results: PersistNoteRefineApplyResult[];
}

// Cross-process editing presence. Two concrete impls:
//   - InMemoryPresenceStore — process-local Map; default for fast unit tests.
//   - PgPresenceStore       — shared via `editing_presence` across web + worker.
// All reads/writes are async to accommodate PG I/O; the in-memory impl resolves
// synchronously.
export interface PresenceStore {
  // Upsert the caller's editing session row, under the shared per-artifact advisory
  // lock so it serializes with hub-sync finalization. Never touches other sessions.
  recordEditingHeartbeat(input: RecordHeartbeatInput): Promise<void>;

  // True when NO session has heartbeat within EDITING_HEARTBEAT_TIMEOUT_MS.
  // Evaluated against database time (clock_timestamp) unless `now` is injected.
  // A never-seen artifact reads as idle (safe default). Expired rows may be swept
  // as best-effort cleanup, but correctness never depends on the sweep.
  isArtifactIdle(artifactId: string, now?: Date): Promise<boolean>;

  // PG applies immediately only when idle with no unfinished queue entries;
  // otherwise append behind the existing obligations.
  enqueueOrApplyNoteRefinePatch(input: EnqueueOrApplyInput): Promise<EnqueueOrApplyResult>;

  // Remove the caller's session; if no active session remains, flush all pending
  // patches in FIFO order (otherwise leave them queued for the session still
  // editing). PG commits each apply and dequeue together; transient failures retain
  // obligations; permanent failures become dead letters.
  markArtifactIdleAndFlush(input: MarkIdleAndFlushInput): Promise<MarkIdleAndFlushResult>;

  // Snapshot of the current session, or null if none recorded.
  getEditingSessionSnapshot(artifactId: string): Promise<EditingSessionSnapshot | null>;

  // Clear all presence state — test helper.
  reset(): Promise<void>;
}
