// Postgres-backed editing presence store (YUK-321 M5 gate 选项 b 前置子任务)。
//
// 设计差异 vs RedisPresenceStore（YUK-171 fail-safe 不移植）：PG 即业务库——
// `persistNoteRefineApply` 同样经 PG 写入，PG 不可用时 apply 也写不进去，故对
// presence 决策做 idle 包装降级无意义（降级后的 apply 仍会 fail）。错误直接抛，
// 与仓库其它 db 路径一致；heartbeat/blur 路由的 try/catch 仍兜 500，但不会把
// 「不可达」伪装成「idle」。子计划 §3 明文不做 fail-safe 降级。
//
// 行堆积：一 artifact 一行（upsert 不增行），单用户量级可忽略——不做清理 job
// （YAGNI）。陈旧 pending（§4 裁决 i：超 EDITING_FORCE_APPLY_TIMEOUT_MS 的项）
// 在 enqueue/flush load 时丢弃并 console.warn 留痕，对齐 Redis 键 30s TTL 的
// 「放弃的编辑会话 pending 自然蒸发」语义。
//
// 原子性：决策（load→判定→入队/写回）在 `SELECT … FOR UPDATE` 行锁事务内；
// `persistNoteRefineApply` 一律在事务外（types.ts L82-83 契约）。镜像 redis.ts
// 「Lua 内决策、JS 外 apply」的分工。
//
// 铁律（YUK-324 教训）：jsonb 列经 drizzle 读出已是解析好的数组——对 `pending`
// 一律直接使用，禁止 JSON.parse。

import { eq, sql } from 'drizzle-orm';

import { persistNoteRefineApply } from '@/capabilities/notes/server/note-refine-apply';
import type { PersistNoteRefineApplyResult } from '@/capabilities/notes/server/note-refine-apply';
import type { Db } from '@/db/client';
import { editing_presence } from '@/db/schema';

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
  type SerializedQueuedPatch,
} from './types';

// DB row shape — drizzle reads timestamptz as Date, jsonb as parsed array.
interface PresenceRow {
  artifact_id: string;
  status: EditingStatus;
  last_heartbeat_at: Date;
  editing_started_at: Date | null;
  pending: SerializedQueuedPatch[];
}

export class PgPresenceStore implements PresenceStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async recordEditingHeartbeat(input: RecordHeartbeatInput): Promise<void> {
    const now = input.now ?? new Date();
    const initialStartedAt = input.status === 'editing' ? now : null;
    // Single upsert — atomic. editing_started_at 语义（types.ts L71-73）：
    // editing 时 COALESCE(旧值, 新值)——首戳不重置；idle 时置 null。
    // `EXCLUDED` 引用待插入行（PG ON CONFLICT 习惯），表列引用旧值。
    await this.db
      .insert(editing_presence)
      .values({
        artifact_id: input.artifactId,
        status: input.status,
        last_heartbeat_at: now,
        editing_started_at: initialStartedAt,
        pending: [],
      })
      .onConflictDoUpdate({
        target: editing_presence.artifact_id,
        set: {
          status: input.status,
          last_heartbeat_at: now,
          editing_started_at: sql`CASE
            WHEN EXCLUDED.status = 'editing'
              THEN COALESCE(${editing_presence.editing_started_at}, EXCLUDED.editing_started_at)
            ELSE NULL
          END`,
        },
      });
  }

  async isArtifactIdle(artifactId: string, now = new Date()): Promise<boolean> {
    // Sticky idle 转换在行锁事务内做：editing 心跳超 30s → 副作用写回 idle。
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(editing_presence)
        .where(eq(editing_presence.artifact_id, artifactId))
        .for('update')
        .limit(1);
      // 无行 = 从未见过——安全默认 idle（不创建状态，镜像 redis IDLE_CHECK_LUA）。
      if (!row) return true;
      if (row.status === 'idle') return true;
      const ageMs = now.getTime() - row.last_heartbeat_at.getTime();
      if (ageMs > EDITING_HEARTBEAT_TIMEOUT_MS) {
        await tx
          .update(editing_presence)
          .set({ status: 'idle', editing_started_at: null })
          .where(eq(editing_presence.artifact_id, artifactId));
        return true;
      }
      return false;
    });
  }

  async enqueueOrApplyNoteRefinePatch(input: EnqueueOrApplyInput): Promise<EnqueueOrApplyResult> {
    const now = input.now ?? new Date();
    const item: SerializedQueuedPatch = {
      patch: input.patch,
      taskResult: input.taskResult,
      triggerEventId: input.triggerEventId ?? null,
      queuedAtMs: now.getTime(),
    };

    // 决策段：行锁事务内 load（无行插初始 idle 行，镜像 in-memory currentState）
    // → 陈旧 pending 丢弃（裁决 i）→ JS 判定 idle（含 sticky 写回）+ force-apply
    // → 不 idle 且不 force：pending 追加写回 commit 返回 deferred；否则 commit
    // 后由事务外 apply。
    const shouldApply = await this.db.transaction(async (tx) => {
      let [row] = await tx
        .select()
        .from(editing_presence)
        .where(eq(editing_presence.artifact_id, input.artifactId))
        .for('update')
        .limit(1);
      if (!row) {
        // 插初始 idle 行——与 in-memory currentState「未见过的 artifact 视作 idle」
        // 等价（idle ⇒ 此分支必然走 apply，初始行仅占位）。
        const initial = {
          artifact_id: input.artifactId,
          status: 'idle' as EditingStatus,
          last_heartbeat_at: now,
          editing_started_at: null as Date | null,
          pending: [] as SerializedQueuedPatch[],
        };
        await tx.insert(editing_presence).values(initial);
        row = initial as PresenceRow;
      }

      // 裁决 i：丢弃陈旧 pending（超 force-apply 上限的项）。
      const freshPending = dropStalePending(row.pending, now, input.artifactId);
      if (freshPending.dropped > 0) {
        await tx
          .update(editing_presence)
          .set({ pending: freshPending.kept })
          .where(eq(editing_presence.artifact_id, input.artifactId));
      }

      // JS 判定（镜像 in-memory L60-69 + shouldForceApply L72-78）。
      let isIdle = false;
      if (row.status === 'idle') {
        isIdle = true;
      } else if (now.getTime() - row.last_heartbeat_at.getTime() > EDITING_HEARTBEAT_TIMEOUT_MS) {
        // Sticky idle 写回——跨进程可见。
        await tx
          .update(editing_presence)
          .set({ status: 'idle', editing_started_at: null })
          .where(eq(editing_presence.artifact_id, input.artifactId));
        isIdle = true;
      }
      if (isIdle) return true;

      const forceApply =
        row.editing_started_at !== null &&
        now.getTime() - row.editing_started_at.getTime() >= EDITING_FORCE_APPLY_TIMEOUT_MS;
      if (forceApply) return true;

      // 不 idle 不 force：入队，写回 commit。
      await tx
        .update(editing_presence)
        .set({ pending: [...freshPending.kept, item] })
        .where(eq(editing_presence.artifact_id, input.artifactId));
      return false;
    });

    if (!shouldApply) {
      return { status: 'deferred', artifact_id: input.artifactId };
    }

    // 事务外 apply（types.ts L82-83）：persistNoteRefineApply 一律用 input.db，
    // 镜像 redis.ts 分工（presence 用构造器 Db，apply 用 input.db）。
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

    // 决策段：行锁事务内 drain（陈旧丢弃 + 读余下 + 置 idle/清空）commit。
    const drained = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(editing_presence)
        .where(eq(editing_presence.artifact_id, input.artifactId))
        .for('update')
        .limit(1);
      if (!row) return [] as SerializedQueuedPatch[];

      const freshPending = dropStalePending(row.pending, now, input.artifactId);

      await tx
        .update(editing_presence)
        .set({
          status: 'idle',
          last_heartbeat_at: now,
          editing_started_at: null,
          pending: [],
        })
        .where(eq(editing_presence.artifact_id, input.artifactId));

      return freshPending.kept;
    });

    // 事务外 FIFO apply（types.ts L82-83）。
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
    const [row] = await this.db
      .select()
      .from(editing_presence)
      .where(eq(editing_presence.artifact_id, artifactId))
      .limit(1);
    if (!row) return null;
    return {
      artifact_id: artifactId,
      status: row.status,
      last_heartbeat_at: row.last_heartbeat_at.toISOString(),
      pending_patches: row.pending?.length ?? 0,
    };
  }

  async reset(): Promise<void> {
    await this.db.delete(editing_presence);
  }
}

// 裁决 i：丢弃 queuedAtMs 距 now 超过 EDITING_FORCE_APPLY_TIMEOUT_MS(10min) 的项。
// Redis 键带 30s TTL，被放弃的编辑会话 pending 自然蒸发；PG 行不过期，故在 load
// 时显式丢弃以保 prod 现行语义。console.warn 带丢弃计数与 artifactId 留痕。
function dropStalePending(
  pending: SerializedQueuedPatch[],
  now: Date,
  artifactId: string,
): { kept: SerializedQueuedPatch[]; dropped: number } {
  const kept: SerializedQueuedPatch[] = [];
  let dropped = 0;
  for (const item of pending) {
    if (now.getTime() - item.queuedAtMs > EDITING_FORCE_APPLY_TIMEOUT_MS) {
      dropped++;
    } else {
      kept.push(item);
    }
  }
  if (dropped > 0) {
    console.warn(
      `[PgPresenceStore] dropped ${dropped} stale pending patch(es) for artifact ${artifactId} (age > ${EDITING_FORCE_APPLY_TIMEOUT_MS}ms)`,
    );
  }
  return { kept, dropped };
}
