import type { PersistNoteRefineApplyResult } from '@/capabilities/notes/server/note-refine-apply';
import type { NotePatchT } from '@/core/schema/note-patch';
import type { Db } from '@/db/client';
import type { TaskTextResult } from '@/server/ai/provenance';

// YUK-384 — editing presence is session-qualified: one `artifact_edit_session`
// row per (artifact, editor session). A session is ACTIVE while its last
// heartbeat is within this window; exactly-30s is still active, only age > 30s
// expires. There is no 10-minute forced apply — an abandoned session simply
// expires after this window and its work applies then.
export const EDITING_HEARTBEAT_TIMEOUT_MS = 30_000;
// Stale-pending TTL: a note-refine patch that has waited in the defer queue
// longer than this is dropped at load time (the queue never self-expires the way
// the old Redis key TTL did). NOT a force-apply-while-editing path.
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

// Serialized shape used by BOTH cross-process stores (Redis string value +
// editing_presence.pending jsonb column) — YUK-321 M5 gate option b. Dates
// travel as ms-since-epoch numbers so the Lua scripts (Redis) and JS (PG)
// can do arithmetic without date parsing. Lifted here from redis.ts so the PG
// store shares the exact same serialization shape (subplan §2 偏差 2).
export interface SerializedQueuedPatch {
  patch: unknown;
  taskResult?: unknown;
  triggerEventId: string | null;
  queuedAtMs: number;
}

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

// Cross-process editing presence (YUK-148 / ADR-0023). Two concrete impls:
//   - InMemoryPresenceStore  — process-local Map; default for fast unit tests.
//   - PgPresenceStore        — shared via the editing_presence PG table across
//     separate web + worker processes (YUK-321 gate 选项 b).
// Both preserve EXACT current semantics of the original editing-session.ts state
// machine (encoded by editing-session.test.ts). All reads/writes are async to
// accommodate PG I/O; the in-memory impl resolves synchronously.
export interface PresenceStore {
  // Upsert the caller's editing session row (keyed by artifact + session), under
  // the shared per-artifact advisory lock so it serializes with hub-sync
  // finalization. Never touches other sessions.
  recordEditingHeartbeat(input: RecordHeartbeatInput): Promise<void>;

  // True when NO session has heartbeat within EDITING_HEARTBEAT_TIMEOUT_MS.
  // Evaluated against database time (clock_timestamp) unless `now` is injected.
  // Exactly-30s counts as active; only age > 30s is idle. A never-seen artifact
  // reads as idle (safe default). Expired rows may be swept as best-effort
  // cleanup, but correctness never depends on the sweep.
  isArtifactIdle(artifactId: string, now?: Date): Promise<boolean>;

  // Apply the patch immediately when the artifact is idle (or past the
  // force-apply ceiling); otherwise enqueue it for later flush. The actual DB
  // write (persistNoteRefineApply) happens outside any atomic section.
  enqueueOrApplyNoteRefinePatch(input: EnqueueOrApplyInput): Promise<EnqueueOrApplyResult>;

  // Remove the caller's editing session; if no active session remains, flush all
  // pending note-refine patches in FIFO order (otherwise leave them queued for
  // the session still editing).
  markArtifactIdleAndFlush(input: MarkIdleAndFlushInput): Promise<MarkIdleAndFlushResult>;

  // Snapshot of the current session, or null if none recorded.
  getEditingSessionSnapshot(artifactId: string): Promise<EditingSessionSnapshot | null>;

  // Clear all presence state — test helper.
  reset(): Promise<void>;
}
