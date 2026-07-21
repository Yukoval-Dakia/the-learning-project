// Postgres-backed editing presence store (YUK-321 M5 gate 选项 b；YUK-384 起
// session-qualified)。
//
// 两张表、两个关注点：
//   1. `artifact_edit_session`（YUK-384）—— 每 (artifact, editor session) 一行的
//      心跳表，驱动「有人在编辑吗」判定（isArtifactIdle）。心跳/blur 在共享
//      per-artifact advisory lock 内 upsert/delete，与 hub-sync finalize 串行化。
//      活跃 = 最近心跳 ≤ 30s（恰 30s 仍活跃，> 30s 过期）。无 10 分钟强制 apply：
//      被遗弃的会话 30s 后自然过期，其排队工作随即 flush。
//   2. `editing_presence.pending`（NON-HUB note-refine defer 队列，保留）—— AI
//      mutator patch 在编辑期入队、会话全空时 FIFO flush。是否 defer 的判定改由
//      session presence（上表）驱动；pending 存储仍在本表。陈旧项（> 10min）在
//      load 时丢弃并 warn，对齐旧 Redis 键 TTL 语义。
//
// 原子性：note-refine apply（persistNoteRefineApply）一律在事务外（types.ts 契约）。
// 铁律（YUK-324）：jsonb `pending` 经 drizzle 读出已是数组，禁止 JSON.parse。

import { eq, sql } from 'drizzle-orm';

import { persistNoteRefineApply } from '@/capabilities/notes/server/note-refine-apply';
import type { PersistNoteRefineApplyResult } from '@/capabilities/notes/server/note-refine-apply';
import type { Db } from '@/db/client';
import { artifact_edit_session, editing_presence } from '@/db/schema';

import {
  EDITING_FORCE_APPLY_TIMEOUT_MS,
  type EditingSessionSnapshot,
  type EnqueueOrApplyInput,
  type EnqueueOrApplyResult,
  type MarkIdleAndFlushInput,
  type MarkIdleAndFlushResult,
  type PresenceStore,
  type QueuedPatch,
  type RecordHeartbeatInput,
  type SerializedQueuedPatch,
} from './types';

const ACTIVE_SESSION_INTERVAL = sql`interval '30 seconds'`;

export class PgPresenceStore implements PresenceStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // Shared per-artifact advisory lock — the SAME key hub-sync finalization takes,
  // so first-heartbeat/reconcile races serialize (YUK-384 RED 16).
  private static advisoryLock(artifactId: string) {
    return sql`select pg_advisory_xact_lock(hashtextextended(${artifactId}, 0))`;
  }

  // A raw Date can't bind as an untyped parameter inside a raw SQL template, so
  // inject an explicitly-cast ISO string; absent `now` uses database time.
  private static stamp(now?: Date) {
    return now === undefined ? sql`clock_timestamp()` : sql`${now.toISOString()}::timestamptz`;
  }

  async recordEditingHeartbeat(input: RecordHeartbeatInput): Promise<void> {
    const at = PgPresenceStore.stamp(input.now);
    await this.db.transaction(async (tx) => {
      await tx.execute(PgPresenceStore.advisoryLock(input.artifactId));
      await tx.execute(sql`
        insert into artifact_edit_session (artifact_id, session_id, started_at, last_heartbeat_at)
        values (${input.artifactId}, ${input.sessionId}, ${at}, ${at})
        on conflict (artifact_id, session_id)
        do update set last_heartbeat_at = ${at}
      `);
    });
  }

  async isArtifactIdle(artifactId: string, now?: Date): Promise<boolean> {
    const at = PgPresenceStore.stamp(now);
    const rows = await this.db.execute<{ idle: boolean }>(sql`
      select not exists(
        select 1 from artifact_edit_session
        where artifact_id = ${artifactId}
          and ${at} - last_heartbeat_at <= ${ACTIVE_SESSION_INTERVAL}
      ) as idle
    `);
    return rows[0]?.idle === true;
  }

  async enqueueOrApplyNoteRefinePatch(input: EnqueueOrApplyInput): Promise<EnqueueOrApplyResult> {
    const now = input.now ?? new Date();
    const at = PgPresenceStore.stamp(now);
    const item: SerializedQueuedPatch = {
      patch: input.patch,
      taskResult: input.taskResult,
      triggerEventId: input.triggerEventId ?? null,
      queuedAtMs: now.getTime(),
    };

    // Serialize the idle-decision AND the enqueue under the SAME shared advisory lock
    // markArtifactIdleAndFlush takes, then re-check idle INSIDE the lock. This closes a
    // TOCTOU window: a concurrent blur could otherwise drain+idle the artifact between a
    // "not idle" read and the append, orphaning the patch in a bag nobody will flush
    // (later dropped after EDITING_FORCE_APPLY_TIMEOUT_MS). If the blur already landed,
    // the in-lock re-check sees idle and we apply now instead of deferring.
    const shouldApply = await this.db.transaction(async (tx) => {
      await tx.execute(PgPresenceStore.advisoryLock(input.artifactId));
      const idleRows = await tx.execute<{ idle: boolean }>(sql`
        select not exists(
          select 1 from artifact_edit_session
          where artifact_id = ${input.artifactId}
            and ${at} - last_heartbeat_at <= ${ACTIVE_SESSION_INTERVAL}
        ) as idle
      `);
      if (idleRows[0]?.idle === true) return true;

      // Actively edited → append to the pending bag under a row lock, dropping any
      // stale entries first (裁决 i). The bag row carries a vestigial status so the
      // NOT NULL columns are satisfied; no code reads it for the defer decision.
      const [row] = await tx
        .select()
        .from(editing_presence)
        .where(eq(editing_presence.artifact_id, input.artifactId))
        .for('update')
        .limit(1);
      const existing = row?.pending ?? [];
      const fresh = dropStalePending(existing, now, input.artifactId);
      const nextPending = [...fresh.kept, item];
      if (!row) {
        await tx
          .insert(editing_presence)
          .values({
            artifact_id: input.artifactId,
            status: 'editing',
            last_heartbeat_at: now,
            editing_started_at: null,
            pending: nextPending,
          })
          .onConflictDoUpdate({
            target: editing_presence.artifact_id,
            set: { pending: nextPending, last_heartbeat_at: now },
          });
      } else {
        await tx
          .update(editing_presence)
          .set({ pending: nextPending, last_heartbeat_at: now })
          .where(eq(editing_presence.artifact_id, input.artifactId));
      }
      return false;
    });

    if (shouldApply) {
      return persistNoteRefineApply({
        db: input.db,
        artifactId: input.artifactId,
        patch: input.patch,
        taskResult: input.taskResult,
        triggerEventId: input.triggerEventId ?? null,
        now,
      });
    }
    return { status: 'deferred', artifact_id: input.artifactId };
  }

  async markArtifactIdleAndFlush(input: MarkIdleAndFlushInput): Promise<MarkIdleAndFlushResult> {
    const now = input.now ?? new Date();
    const at = PgPresenceStore.stamp(input.now);

    // Remove exactly this session; flush only if no active session remains. Both
    // happen inside the shared advisory lock so a concurrent heartbeat/finalize
    // observes a consistent session set.
    const idleAfterBlur = await this.db.transaction(async (tx) => {
      await tx.execute(PgPresenceStore.advisoryLock(input.artifactId));
      await tx.execute(sql`
        delete from artifact_edit_session
        where artifact_id = ${input.artifactId} and session_id = ${input.sessionId}
      `);
      const rows = await tx.execute<{ active: boolean }>(sql`
        select exists(
          select 1 from artifact_edit_session
          where artifact_id = ${input.artifactId}
            and ${at} - last_heartbeat_at <= ${ACTIVE_SESSION_INTERVAL}
        ) as active
      `);
      return rows[0]?.active !== true;
    });

    if (!idleAfterBlur) {
      // Another session is still editing — leave the queue intact.
      return { artifact_id: input.artifactId, flushed: 0, results: [] };
    }

    // Drain the pending bag (drop stale) under a row lock, then apply outside the
    // transaction in FIFO order (types.ts contract).
    const drained = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(editing_presence)
        .where(eq(editing_presence.artifact_id, input.artifactId))
        .for('update')
        .limit(1);
      if (!row) return [] as SerializedQueuedPatch[];
      const fresh = dropStalePending(row.pending, now, input.artifactId);
      await tx
        .update(editing_presence)
        .set({ status: 'idle', last_heartbeat_at: now, editing_started_at: null, pending: [] })
        .where(eq(editing_presence.artifact_id, input.artifactId));
      return fresh.kept;
    });

    const results: PersistNoteRefineApplyResult[] = [];
    for (const queued of drained) {
      results.push(
        await persistNoteRefineApply({
          db: input.db,
          artifactId: input.artifactId,
          patch: queued.patch as QueuedPatch['patch'],
          taskResult: queued.taskResult as QueuedPatch['taskResult'],
          triggerEventId: queued.triggerEventId ?? null,
          now,
        }),
      );
    }
    return { artifact_id: input.artifactId, flushed: drained.length, results };
  }

  async getEditingSessionSnapshot(artifactId: string): Promise<EditingSessionSnapshot | null> {
    const sessions = await this.db.execute<{ last_heartbeat_at: string | Date }>(sql`
      select last_heartbeat_at from artifact_edit_session
      where artifact_id = ${artifactId}
      order by last_heartbeat_at desc
    `);
    const [presence] = await this.db
      .select()
      .from(editing_presence)
      .where(eq(editing_presence.artifact_id, artifactId))
      .limit(1);

    if (sessions.length === 0 && !presence) return null;
    // Raw execute() returns timestamptz as a string; the drizzle select returns a
    // Date. Coerce so toISOString() is safe for either source.
    const latestRaw = sessions[0]?.last_heartbeat_at ?? presence?.last_heartbeat_at ?? new Date();
    const latest = latestRaw instanceof Date ? latestRaw : new Date(latestRaw);
    return {
      artifact_id: artifactId,
      // Existence-based (informational): any live session row reads as editing.
      // isArtifactIdle is the load-bearing windowed check.
      status: sessions.length > 0 ? 'editing' : 'idle',
      last_heartbeat_at: latest.toISOString(),
      pending_patches: presence?.pending?.length ?? 0,
    };
  }

  async reset(): Promise<void> {
    await this.db.delete(artifact_edit_session);
    await this.db.delete(editing_presence);
  }
}

// 裁决 i：丢弃 queuedAtMs 距 now 超过 EDITING_FORCE_APPLY_TIMEOUT_MS(10min) 的项。
// PG 行不过期，故 load 时显式丢弃以保旧语义。console.warn 带丢弃计数与 artifactId。
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
