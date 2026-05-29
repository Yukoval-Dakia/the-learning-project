import type Redis from 'ioredis';

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

const KEY_PREFIX = 'editing:';

// The whole per-artifact presence state lives in ONE Redis string key, holding
// this JSON shape. Dates are carried as ms-since-epoch numbers so the Lua
// scripts can do arithmetic (`now - lastHeartbeatAt > timeout`) without date
// parsing. pending carries each QueuedPatch with queuedAt as ms epoch too.
interface SerializedQueuedPatch {
  patch: unknown;
  taskResult?: unknown;
  triggerEventId: string | null;
  queuedAtMs: number;
}
interface SerializedState {
  status: EditingStatus;
  lastHeartbeatAtMs: number;
  editingStartedAtMs: number | null;
  pending: SerializedQueuedPatch[];
}

// ioredis augments the client with our custom commands at runtime via
// defineCommand. We declare the call signatures here so TS accepts them.
interface PresenceCommands {
  presenceHeartbeat(key: string, nowMs: string, status: string, ttlMs: string): Promise<unknown>;
  presenceIdleCheck(key: string, nowMs: string, timeoutMs: string, ttlMs: string): Promise<string>;
  presenceDecide(
    key: string,
    nowMs: string,
    timeoutMs: string,
    forceMs: string,
    ttlMs: string,
    queuedItemJson: string,
  ): Promise<string>;
  presenceFlush(key: string, nowMs: string, ttlMs: string): Promise<string | null>;
  presenceSnapshot(key: string): Promise<string | null>;
}

type PresenceRedis = Redis & PresenceCommands;

// Shared Lua prelude: decode the key's JSON (or build a fresh idle state),
// plus the sticky idle-timeout transition. Each script re-derives state from
// the single key so the whole compound op is atomic under Redis's
// single-threaded execution — no WATCH/MULTI retry loop needed.
const LUA_PRELUDE = `
local function load_state(raw, now)
  if raw == false or raw == nil then
    return { status = 'idle', lastHeartbeatAtMs = now, editingStartedAtMs = nil, pending = {} }
  end
  local s = cjson.decode(raw)
  if s.pending == nil then s.pending = {} end
  return s
end

-- Returns true if the (in-script, possibly-mutated) state is idle. Mirrors
-- isArtifactIdle: idle status -> idle; editing past timeout -> sticky idle.
local function is_idle(s, now, timeout)
  if s.status == 'idle' then return true end
  if (now - s.lastHeartbeatAtMs) > timeout then
    s.status = 'idle'
    s.editingStartedAtMs = nil
    return true
  end
  return false
end

local function should_force_apply(s, now, force)
  return s.status == 'editing'
    and s.editingStartedAtMs ~= nil
    and (now - s.editingStartedAtMs) >= force
end
`;

const HEARTBEAT_LUA = `${LUA_PRELUDE}
local now = tonumber(ARGV[1])
local status = ARGV[2]
local ttl = tonumber(ARGV[3])
local s = load_state(redis.call('GET', KEYS[1]), now)
s.status = status
s.lastHeartbeatAtMs = now
if status == 'editing' then
  if s.editingStartedAtMs == nil then s.editingStartedAtMs = now end
else
  s.editingStartedAtMs = nil
end
redis.call('SET', KEYS[1], cjson.encode(s), 'PX', ttl)
return 1
`;

const IDLE_CHECK_LUA = `${LUA_PRELUDE}
-- A missing key reads as idle (safe default) WITHOUT creating state.
local raw = redis.call('GET', KEYS[1])
if raw == false then return '1' end
local now = tonumber(ARGV[1])
local timeout = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local s = load_state(raw, now)
local idle = is_idle(s, now, timeout)
-- Persist the sticky transition (status flipped to idle) so subsequent reads
-- across processes observe it.
redis.call('SET', KEYS[1], cjson.encode(s), 'PX', ttl)
if idle then return '1' else return '0' end
`;

// Compound decision for enqueueOrApply. Mirrors the in-memory order exactly:
// currentState (load) -> isArtifactIdle (sticky) -> shouldForceApply -> enqueue.
// Returns 'apply' (caller does the DB write) or 'deferred' (item appended).
const DECIDE_LUA = `${LUA_PRELUDE}
local now = tonumber(ARGV[1])
local timeout = tonumber(ARGV[2])
local force = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local item = ARGV[5]
local s = load_state(redis.call('GET', KEYS[1]), now)
local idle = is_idle(s, now, timeout)
if (not idle) and (not should_force_apply(s, now, force)) then
  table.insert(s.pending, cjson.decode(item))
  redis.call('SET', KEYS[1], cjson.encode(s), 'PX', ttl)
  return 'deferred'
end
-- Persist any sticky idle transition before the caller applies.
redis.call('SET', KEYS[1], cjson.encode(s), 'PX', ttl)
return 'apply'
`;

// Atomically drain pending + mark idle. Returns the drained pending list as a
// JSON array string so the caller can apply each (DB writes happen outside the
// script). Always returns a JSON array (never nil) to keep the JS side simple.
const FLUSH_LUA = `${LUA_PRELUDE}
local now = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local s = load_state(redis.call('GET', KEYS[1]), now)
local pending = s.pending
s.status = 'idle'
s.lastHeartbeatAtMs = now
s.editingStartedAtMs = nil
s.pending = {}
redis.call('SET', KEYS[1], cjson.encode(s), 'PX', ttl)
if #pending == 0 then return '[]' end
return cjson.encode(pending)
`;

const SNAPSHOT_LUA = `
local raw = redis.call('GET', KEYS[1])
if raw == false then return false end
return raw
`;

let scriptsDefined: WeakSet<Redis> | undefined;

function defineScripts(redis: Redis): void {
  scriptsDefined ??= new WeakSet();
  if (scriptsDefined.has(redis)) return;
  redis.defineCommand('presenceHeartbeat', { numberOfKeys: 1, lua: HEARTBEAT_LUA });
  redis.defineCommand('presenceIdleCheck', { numberOfKeys: 1, lua: IDLE_CHECK_LUA });
  redis.defineCommand('presenceDecide', { numberOfKeys: 1, lua: DECIDE_LUA });
  redis.defineCommand('presenceFlush', { numberOfKeys: 1, lua: FLUSH_LUA });
  redis.defineCommand('presenceSnapshot', { numberOfKeys: 1, lua: SNAPSHOT_LUA });
  scriptsDefined.add(redis);
}

// Redis-backed presence store (YUK-148 / ADR-0023). Selected when REDIS_URL is
// set so the Next web process and the pg-boss worker process share presence via
// one Redis server. Compound ops run as single Lua scripts (atomic under
// Redis's single-threaded model); the DB side effect (persistNoteRefineApply)
// runs in JS AFTER the script decides, because Lua cannot touch Postgres.
export class RedisPresenceStore implements PresenceStore {
  private readonly redis: PresenceRedis;
  private readonly ttlMs: number;

  constructor(redis: Redis, ttlMs: number = EDITING_HEARTBEAT_TIMEOUT_MS) {
    defineScripts(redis);
    this.redis = redis as PresenceRedis;
    // TTL aligned to the heartbeat timeout so stale presence self-expires.
    // Enqueued patches extend the lifetime via re-SET, so a deferred queue
    // can't silently expire mid-edit; an idle session simply ages out.
    this.ttlMs = ttlMs;
  }

  private key(artifactId: string): string {
    return `${KEY_PREFIX}${artifactId}`;
  }

  async recordEditingHeartbeat(input: RecordHeartbeatInput): Promise<void> {
    const now = (input.now ?? new Date()).getTime();
    // ARGV order must match HEARTBEAT_LUA: now, status, ttl.
    await this.redis.presenceHeartbeat(
      this.key(input.artifactId),
      String(now),
      input.status,
      String(this.ttlMs),
    );
  }

  async isArtifactIdle(artifactId: string, now = new Date()): Promise<boolean> {
    const res = await this.redis.presenceIdleCheck(
      this.key(artifactId),
      String(now.getTime()),
      String(EDITING_HEARTBEAT_TIMEOUT_MS),
      String(this.ttlMs),
    );
    return res === '1';
  }

  async enqueueOrApplyNoteRefinePatch(input: EnqueueOrApplyInput): Promise<EnqueueOrApplyResult> {
    const now = input.now ?? new Date();
    const item: SerializedQueuedPatch = {
      patch: input.patch,
      taskResult: input.taskResult,
      triggerEventId: input.triggerEventId ?? null,
      queuedAtMs: now.getTime(),
    };
    const decision = await this.redis.presenceDecide(
      this.key(input.artifactId),
      String(now.getTime()),
      String(EDITING_HEARTBEAT_TIMEOUT_MS),
      String(EDITING_FORCE_APPLY_TIMEOUT_MS),
      String(this.ttlMs),
      JSON.stringify(item),
    );
    if (decision === 'deferred') {
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
    const drainedJson = await this.redis.presenceFlush(
      this.key(input.artifactId),
      String(now.getTime()),
      String(this.ttlMs),
    );
    const drained: SerializedQueuedPatch[] = drainedJson ? JSON.parse(drainedJson) : [];
    const results: PersistNoteRefineApplyResult[] = [];
    for (const item of drained) {
      const result = await persistNoteRefineApply({
        db: input.db,
        artifactId: input.artifactId,
        patch: item.patch as QueuedPatch['patch'],
        taskResult: item.taskResult as QueuedPatch['taskResult'],
        triggerEventId: item.triggerEventId ?? null,
        now,
      });
      results.push(result);
    }
    return { artifact_id: input.artifactId, flushed: drained.length, results };
  }

  async getEditingSessionSnapshot(artifactId: string): Promise<EditingSessionSnapshot | null> {
    const raw = await this.redis.presenceSnapshot(this.key(artifactId));
    if (!raw) return null;
    const s: SerializedState = JSON.parse(raw);
    return {
      artifact_id: artifactId,
      status: s.status,
      last_heartbeat_at: new Date(s.lastHeartbeatAtMs).toISOString(),
      pending_patches: s.pending?.length ?? 0,
    };
  }

  async reset(): Promise<void> {
    // Clear only this store's namespace so a shared Redis used by other state
    // is untouched. Scan-and-del keeps it safe on large keyspaces.
    const stream = this.redis.scanStream({ match: `${KEY_PREFIX}*`, count: 100 });
    for await (const keys of stream as AsyncIterable<string[]>) {
      if (keys.length > 0) await this.redis.del(...keys);
    }
  }
}
