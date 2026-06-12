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

export {
  EDITING_FORCE_APPLY_TIMEOUT_MS,
  EDITING_HEARTBEAT_TIMEOUT_MS,
  type EditingStatus,
} from './presence/types';

// M5-T5c (YUK-321) — Redis 退役（gate 选项 b）：prod 拓扑保持双进程
// （app + worker），跨进程 presence 改走 PG 表——恒用 PgPresenceStore
// （gate 前置子任务实施的第三实现，ADR-0023 的 PresenceStore seam 保留）。
// RedisPresenceStore 已随旧依赖一并移除。
//
// Lazy singleton: the store is created once and reused for the life of the
// process. Don't open a PG connection per call (db is the shared singleton).
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

// Resets the active store. In the fast unit suite, @/db/client + presence/pg
// are vi.mock'd so PgPresenceStore resolves to InMemoryPresenceStore (clears
// the in-memory Map). In pg.db.test.ts, resets the editing_presence table.
export function resetEditingSessionStateForTests(): Promise<void> {
  return getPresenceStore().reset();
}
