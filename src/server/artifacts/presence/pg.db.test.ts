// PgPresenceStore 契约 + 跨进程 + 陈旧 pending 测试（YUK-321 M5 gate 选项 b 前置）。
//
// 直接构造 PgPresenceStore（不经 facade——selection 切换在 Task 9），三组场景：
//   1. 状态机契约——移植 editing-session.test.ts 全部 11 场景（保真 in-memory 状态机）
//   2. 跨进程语义——两实例共享同一 PG（web/worker 等价）
//   3. 陈旧 pending（裁决 i）——超 10min 项在 flush/enqueue load 时丢弃且 warn
//
// DB 分区：走 testcontainer；beforeEach resetDb() 保持 hermetic。
// persistNoteRefineApply mock 照搬 redis.integration.test.ts 模式。

import type { NotePatchT } from '@/core/schema/note-patch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetDb, testDb } from '../../../../tests/helpers/db';

// mock persistNoteRefineApply（DB 写副作用与此处 presence 测试解耦）。
const persistNoteRefineApply = vi.fn(async (args: { artifactId: string }) => ({
  status: 'applied' as const,
  artifact_id: args.artifactId,
}));
vi.mock('@/capabilities/notes/server/note-refine-apply', () => ({
  persistNoteRefineApply: (args: { artifactId: string }) => persistNoteRefineApply(args),
}));

// pg.ts 必须在 mock 之后导入（它 import persistNoteRefineApply）。
import { PgPresenceStore } from './pg';
import { EDITING_FORCE_APPLY_TIMEOUT_MS, EDITING_HEARTBEAT_TIMEOUT_MS } from './types';

const patch = { ops: [{ kind: 'append_block', block: {} }] } as unknown as NotePatchT;
const db = {} as never; // apply 走 mock，无需真实 db
const T0 = new Date('2026-05-28T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

// 时间手法说明（偏差自报）：in-memory 源测试以 JS Date 推进时间——pg.ts 同样
// 在 JS 侧用 `now.getTime() - row.last_heartbeat_at.getTime()` 判定，故同一手法
// 直接可用（DB 不调 now()，所有时间戳由调用方注入，跨进程一致）。

beforeEach(async () => {
  await resetDb();
  persistNoteRefineApply.mockClear();
});

// ─────────────────────────────────────────────────────────────────────────────
// 组 1：状态机契约（移植 editing-session.test.ts 全部 11 场景）
// ─────────────────────────────────────────────────────────────────────────────

describe('PgPresenceStore — 状态机契约 (移植 editing-session.test.ts)', () => {
  let store: PgPresenceStore;
  beforeEach(() => {
    store = new PgPresenceStore(testDb());
  });

  describe('isArtifactIdle', () => {
    it('treats an artifact with no recorded session as idle', async () => {
      expect(await store.isArtifactIdle('art_unknown', T0)).toBe(true);
    });

    it('returns false while a fresh editing heartbeat is within the timeout window', async () => {
      await store.recordEditingHeartbeat({ artifactId: 'art_1', status: 'editing', now: T0 });
      expect(await store.isArtifactIdle('art_1', at(EDITING_HEARTBEAT_TIMEOUT_MS - 1))).toBe(false);
    });

    it('auto-transitions an editing artifact to idle once the heartbeat times out', async () => {
      await store.recordEditingHeartbeat({ artifactId: 'art_1', status: 'editing', now: T0 });
      expect(await store.isArtifactIdle('art_1', at(EDITING_HEARTBEAT_TIMEOUT_MS + 1))).toBe(true);
      // sticky：snapshot 现在读 idle。
      expect((await store.getEditingSessionSnapshot('art_1'))?.status).toBe('idle');
    });

    it('returns true immediately for an explicitly idle heartbeat', async () => {
      await store.recordEditingHeartbeat({ artifactId: 'art_1', status: 'idle', now: T0 });
      expect(await store.isArtifactIdle('art_1', T0)).toBe(true);
    });
  });

  describe('recordEditingHeartbeat', () => {
    it('stamps editingStartedAt only on the first editing heartbeat and clears it on idle', async () => {
      await store.recordEditingHeartbeat({ artifactId: 'art_1', status: 'editing', now: T0 });
      // 第二个 editing 心跳不得重置 force-apply 时钟——否则永远到不了 force 窗口。
      await store.recordEditingHeartbeat({
        artifactId: 'art_1',
        status: 'editing',
        now: at(5_000),
      });
      expect(await store.isArtifactIdle('art_1', at(5_000))).toBe(false);

      await store.recordEditingHeartbeat({ artifactId: 'art_1', status: 'idle', now: at(6_000) });
      expect(await store.isArtifactIdle('art_1', at(6_000))).toBe(true);
    });
  });

  describe('enqueueOrApplyNoteRefinePatch', () => {
    it('applies immediately when the artifact is idle', async () => {
      const result = await store.enqueueOrApplyNoteRefinePatch({
        db,
        artifactId: 'art_1',
        patch,
        now: T0,
      });
      expect(result.status).toBe('applied');
      expect(persistNoteRefineApply).toHaveBeenCalledTimes(1);
    });

    it('defers the patch while the artifact is actively being edited', async () => {
      await store.recordEditingHeartbeat({ artifactId: 'art_1', status: 'editing', now: T0 });
      const result = await store.enqueueOrApplyNoteRefinePatch({
        db,
        artifactId: 'art_1',
        patch,
        now: at(1_000),
      });
      expect(result).toEqual({ status: 'deferred', artifact_id: 'art_1' });
      expect(persistNoteRefineApply).not.toHaveBeenCalled();
      expect((await store.getEditingSessionSnapshot('art_1'))?.pending_patches).toBe(1);
    });

    it('force-applies a patch once editing exceeds the force-apply timeout', async () => {
      await store.recordEditingHeartbeat({ artifactId: 'art_1', status: 'editing', now: T0 });
      // 持续心跳使 isArtifactIdle 不短路；编辑会话至此已过 force-apply 上限。
      await store.recordEditingHeartbeat({
        artifactId: 'art_1',
        status: 'editing',
        now: at(EDITING_FORCE_APPLY_TIMEOUT_MS),
      });
      const result = await store.enqueueOrApplyNoteRefinePatch({
        db,
        artifactId: 'art_1',
        patch,
        now: at(EDITING_FORCE_APPLY_TIMEOUT_MS),
      });
      expect(result.status).toBe('applied');
      expect(persistNoteRefineApply).toHaveBeenCalledTimes(1);
    });
  });

  describe('markArtifactIdleAndFlush', () => {
    it('flushes queued patches in order and reports the flushed count', async () => {
      await store.recordEditingHeartbeat({ artifactId: 'art_1', status: 'editing', now: T0 });
      await store.enqueueOrApplyNoteRefinePatch({ db, artifactId: 'art_1', patch, now: at(1_000) });
      await store.enqueueOrApplyNoteRefinePatch({ db, artifactId: 'art_1', patch, now: at(2_000) });
      expect(persistNoteRefineApply).not.toHaveBeenCalled();

      const flush = await store.markArtifactIdleAndFlush({
        db,
        artifactId: 'art_1',
        now: at(3_000),
      });
      expect(flush.flushed).toBe(2);
      expect(flush.results).toHaveLength(2);
      expect(persistNoteRefineApply).toHaveBeenCalledTimes(2);
      // 队列已清空 + session idle。
      expect((await store.getEditingSessionSnapshot('art_1'))?.pending_patches).toBe(0);
      expect(await store.isArtifactIdle('art_1', at(3_000))).toBe(true);
    });

    it('is a no-op flush when there are no pending patches', async () => {
      const flush = await store.markArtifactIdleAndFlush({ db, artifactId: 'art_idle', now: T0 });
      expect(flush.flushed).toBe(0);
      expect(persistNoteRefineApply).not.toHaveBeenCalled();
    });
  });

  describe('getEditingSessionSnapshot', () => {
    it('returns null for an artifact that has never had a session', async () => {
      expect(await store.getEditingSessionSnapshot('art_none')).toBeNull();
    });

    it('exposes status, heartbeat time, and pending count for an active session', async () => {
      await store.recordEditingHeartbeat({ artifactId: 'art_1', status: 'editing', now: T0 });
      await store.enqueueOrApplyNoteRefinePatch({ db, artifactId: 'art_1', patch, now: at(1_000) });
      const snapshot = await store.getEditingSessionSnapshot('art_1');
      expect(snapshot).toEqual({
        artifact_id: 'art_1',
        status: 'editing',
        last_heartbeat_at: T0.toISOString(),
        pending_patches: 1,
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 组 2：跨进程语义（移植 redis.integration.test.ts 核心 2 场景）
// ─────────────────────────────────────────────────────────────────────────────

describe('PgPresenceStore — 跨进程语义 (两实例共享同一 PG)', () => {
  let storeA: PgPresenceStore;
  let storeB: PgPresenceStore;
  beforeEach(() => {
    storeA = new PgPresenceStore(testDb());
    storeB = new PgPresenceStore(testDb());
  });

  it('instance B sees an editing heartbeat recorded by instance A (presence is shared)', async () => {
    const now = new Date('2026-05-30T12:00:00.000Z');
    // 「web」进程记录用户正在编辑。
    await storeA.recordEditingHeartbeat({ artifactId: 'art_shared', status: 'editing', now });

    // 「worker」进程——不同实例——必须 NOT see idle，故 defer 而非覆盖。
    expect(await storeB.isArtifactIdle('art_shared', now)).toBe(false);

    const decision = await storeB.enqueueOrApplyNoteRefinePatch({
      db,
      artifactId: 'art_shared',
      patch,
      now: new Date(now.getTime() + 1_000),
    });
    expect(decision).toEqual({ status: 'deferred', artifact_id: 'art_shared' });
  });

  it('the deferred patch enqueued via A flushes via B once the session goes idle', async () => {
    const now = new Date('2026-05-30T12:00:00.000Z');
    await storeA.recordEditingHeartbeat({ artifactId: 'art_flush', status: 'editing', now });
    await storeA.enqueueOrApplyNoteRefinePatch({
      db,
      artifactId: 'art_flush',
      patch,
      now: new Date(now.getTime() + 1_000),
    });

    // Worker 实例 flush；必须看到 A 入队的 patch。
    const flush = await storeB.markArtifactIdleAndFlush({
      db,
      artifactId: 'art_flush',
      now: new Date(now.getTime() + 2_000),
    });
    expect(flush.flushed).toBe(1);
    expect(await storeA.isArtifactIdle('art_flush', new Date(now.getTime() + 2_000))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 组 3：陈旧 pending（裁决 i）——超 10min 项丢弃且 warn
// ─────────────────────────────────────────────────────────────────────────────

describe('PgPresenceStore — 陈旧 pending 丢弃 (裁决 i)', () => {
  let store: PgPresenceStore;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    store = new PgPresenceStore(testDb());
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops pending patches older than EDITING_FORCE_APPLY_TIMEOUT_MS during flush and warns', async () => {
    // 直接构造行：两条 pending 的 queuedAtMs 距 flush 时点都 > 10min（陈旧）。
    // 时间真相全由 queuedAtMs 与 flush now 的差值决定（裁决 i 逻辑）。
    const realDb = testDb();
    const { editing_presence } = await import('@/db/schema');
    const flushAt = at(11 * 60_000); // T0 + 11min
    await realDb.insert(editing_presence).values({
      artifact_id: 'art_stale',
      status: 'editing',
      last_heartbeat_at: at(10 * 60_000), // 会话本身新鲜（不影响 stale pending 判定）
      editing_started_at: at(10 * 60_000),
      pending: [
        { patch, triggerEventId: null, queuedAtMs: T0.getTime() }, // age 11min → stale
        { patch, triggerEventId: null, queuedAtMs: at(1_000).getTime() }, // age ~11min → stale
      ],
    });

    const flush = await store.markArtifactIdleAndFlush({
      db,
      artifactId: 'art_stale',
      now: flushAt,
    });
    expect(flush.flushed).toBe(0);
    expect(flush.results).toHaveLength(0);
    expect(persistNoteRefineApply).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('dropped 2 stale pending patch(es)'),
    );
  });

  it('drops stale pending during enqueue load (kept fresh ones still enqueued)', async () => {
    // 直接构造行：editing 会话新鲜（heartbeat < 30s、editing_started_at < 10min，
    // 故 neither idle nor force-apply），pending 含一陈旧一新鲜。
    const realDb = testDb();
    const { editing_presence } = await import('@/db/schema');
    const enqueueAt = at(11 * 60_000); // T0 + 11min
    await realDb.insert(editing_presence).values({
      artifact_id: 'art_mix',
      status: 'editing',
      last_heartbeat_at: at(11 * 60_000 - 5_000), // age 5s < 30s → 不 idle
      editing_started_at: at(10 * 60_000), // age 1min < 10min → 不 force-apply
      pending: [
        // 陈旧：queuedAtMs 距 enqueueAt > 10min。
        { patch, triggerEventId: null, queuedAtMs: T0.getTime() },
        // 新鲜：queuedAtMs 距 enqueueAt < 10min。
        { patch, triggerEventId: null, queuedAtMs: at(10 * 60_000 + 30_000).getTime() },
      ],
    });

    // enqueue 触发 load：陈旧被丢，新鲜保留 + 当前 patch 追加；session 仍 active → defer。
    const result = await store.enqueueOrApplyNoteRefinePatch({
      db,
      artifactId: 'art_mix',
      patch,
      now: enqueueAt,
    });
    expect(result).toEqual({ status: 'deferred', artifact_id: 'art_mix' });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('dropped 1 stale pending patch(es)'),
    );
    // 队列长度 = 1 新鲜 + 1 当前 = 2（陈旧的已丢）。
    expect((await store.getEditingSessionSnapshot('art_mix'))?.pending_patches).toBe(2);
  });
});
