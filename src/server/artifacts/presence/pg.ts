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
//      load 时丢弃并 warn；已开始 drain 的项保留至事务内完成 apply + 出队。
//
// 原子性：drain 的正文、事件与逐项出队共用事务，失败/退出不会清掉剩余义务。
// 铁律（YUK-324）：jsonb `pending` 经 drizzle 读出已是数组，禁止 JSON.parse。

import { eq, sql } from 'drizzle-orm';

import {
  type PersistNoteRefineApplyResult,
  persistNoteRefineApply,
} from '@/capabilities/notes/public';
import { NoteRefineApplyError } from '@/core/blocks/apply-note-patch';
import type { Db } from '@/db/client';
import { artifact_edit_session, editing_presence } from '@/db/schema';

import {
  EDITING_FORCE_APPLY_TIMEOUT_MS,
  type EditingSessionSnapshot,
  type EnqueueOrApplyInput,
  type EnqueueOrApplyResult,
  HUB_AUTO_SYNC_ACTOR_REF,
  type MarkIdleAndFlushInput,
  type MarkIdleAndFlushResult,
  type NoteRefineQueueEntry,
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

    // Keep the backlog decision and immediate apply under the drain's lock so a
    // new writer cannot overtake an unfinished patch between decision and commit.
    return this.db.transaction(async (tx) => {
      await tx.execute(PgPresenceStore.advisoryLock(input.artifactId));
      const idleRows = await tx.execute<{ idle: boolean }>(sql`
        select not exists(
          select 1 from artifact_edit_session
          where artifact_id = ${input.artifactId}
            and ${at} - last_heartbeat_at <= ${ACTIVE_SESSION_INTERVAL}
        ) as idle
      `);
      const [row] = await tx
        .select()
        .from(editing_presence)
        .where(eq(editing_presence.artifact_id, input.artifactId))
        .for('update')
        .limit(1);
      const existing = row?.pending ?? [];
      const fresh = dropStalePending(existing, now, input.artifactId);
      const idle = idleRows[0]?.idle === true;
      if (idle && !fresh.kept.some((entry) => entry.state !== 'dead')) {
        return persistNoteRefineApply({
          db: tx,
          artifactId: input.artifactId,
          patch: input.patch,
          taskResult: input.taskResult,
          triggerEventId: input.triggerEventId ?? null,
          now,
        });
      }
      const item: NoteRefineQueueEntry = {
        state: idle ? 'draining' : 'pending',
        patch: input.patch,
        taskResult: input.taskResult,
        triggerEventId: input.triggerEventId ?? null,
        queuedAtMs: now.getTime(),
      };
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
      return { status: 'deferred', artifact_id: input.artifactId };
    });
  }

  async markArtifactIdleAndFlush(input: MarkIdleAndFlushInput): Promise<MarkIdleAndFlushResult> {
    const now = input.now ?? new Date();
    const at = PgPresenceStore.stamp(input.now);

    // Admission commits before apply so a failure cannot make this batch eligible
    // for TTL pruning on its next retry. Each item is still in the durable queue.
    const pendingCount = await this.db.transaction(async (tx) => {
      await tx.execute(PgPresenceStore.advisoryLock(input.artifactId));
      // Remove exactly this session.
      await tx.execute(sql`
        delete from artifact_edit_session
        where artifact_id = ${input.artifactId} and session_id = ${input.sessionId}
      `);
      const [row] = await tx
        .select()
        .from(editing_presence)
        .where(eq(editing_presence.artifact_id, input.artifactId))
        .for('update')
        .limit(1);
      // Flush ONLY if no active session remains — re-checked here holding both the
      // advisory lock and the pending-row lock, so a session that (re)appeared after the
      // blur can never be flushed over.
      const activeRows = await tx.execute<{ active: boolean }>(sql`
        select exists(
          select 1 from artifact_edit_session
          where artifact_id = ${input.artifactId}
            and ${at} - last_heartbeat_at <= ${ACTIVE_SESSION_INTERVAL}
        ) as active
      `);
      if (activeRows[0]?.active === true) return null;
      if (!row) return 0;
      const fresh = dropStalePending(row.pending, now, input.artifactId);
      await tx
        .update(editing_presence)
        .set({
          status: 'idle',
          last_heartbeat_at: now,
          editing_started_at: null,
          pending: fresh.kept.map((queued) =>
            queued.state === 'pending' ? { ...queued, state: 'draining' } : queued,
          ),
        })
        .where(eq(editing_presence.artifact_id, input.artifactId));
      return fresh.kept.filter((queued) => queued.state !== 'dead').length;
    });

    if (pendingCount === null) {
      // Another session is still editing — leave the queue intact.
      return { artifact_id: input.artifactId, flushed: 0, results: [] };
    }

    const results: PersistNoteRefineApplyResult[] = [];
    for (let index = 0; index < pendingCount; index++) {
      const result = await this.db.transaction(async (tx) => {
        await tx.execute(PgPresenceStore.advisoryLock(input.artifactId));
        const [row] = await tx
          .select()
          .from(editing_presence)
          .where(eq(editing_presence.artifact_id, input.artifactId))
          .for('update')
          .limit(1);
        if (!row) return null;
        const headIndex = row.pending.findIndex((queued) => queued.state !== 'dead');
        const queued = row.pending[headIndex];
        if (queued?.state !== 'draining') return null;
        const activeRows = await tx.execute<{ active: boolean }>(sql`
          select exists(
            select 1 from artifact_edit_session
            where artifact_id = ${input.artifactId}
              and ${at} - last_heartbeat_at <= ${ACTIVE_SESSION_INTERVAL}
          ) as active
        `);
        if (activeRows[0]?.active === true) return null;

        let applied: PersistNoteRefineApplyResult;
        try {
          // Roll back the failed apply before committing its terminal disposition.
          applied = await tx.transaction((applyTx) =>
            persistNoteRefineApply({
              db: applyTx,
              artifactId: input.artifactId,
              patch: queued.patch as QueuedPatch['patch'],
              taskResult: queued.taskResult as QueuedPatch['taskResult'],
              triggerEventId: queued.triggerEventId ?? null,
              now,
            }),
          );
        } catch (error) {
          if (!(error instanceof NoteRefineApplyError)) throw error;
          const dead: NoteRefineQueueEntry = {
            ...queued,
            state: 'dead',
            failure: { code: error.code, message: error.message, failedAtMs: now.getTime() },
          };
          await tx
            .update(editing_presence)
            .set({
              pending: row.pending.map((entry, index) => (index === headIndex ? dead : entry)),
            })
            .where(eq(editing_presence.artifact_id, input.artifactId));
          return { status: 'dead' } as const;
        }
        // A CAS conflict is retryable, unlike the other terminal no-op results.
        if (applied.status !== 'skipped:version_conflict') {
          await tx
            .update(editing_presence)
            .set({ pending: row.pending.filter((_, index) => index !== headIndex) })
            .where(eq(editing_presence.artifact_id, input.artifactId));
        }
        return applied;
      });
      if (result === null) break;
      if (result.status === 'dead') continue;
      results.push(result);
      if (result.status === 'skipped:version_conflict') break;
    }
    return { artifact_id: input.artifactId, flushed: results.length, results };
  }

  async getEditingSessionSnapshot(artifactId: string): Promise<EditingSessionSnapshot | null> {
    // X5: only sessions within the 30s active window count as 'editing' — same fence as
    // isArtifactIdle — so an abandoned/zombie heartbeat row (browser crash → no blur, not yet
    // swept) does not make the snapshot falsely read 'editing'.
    const sessions = await this.db.execute<{ last_heartbeat_at: string | Date }>(sql`
      select last_heartbeat_at from artifact_edit_session
      where artifact_id = ${artifactId}
        and clock_timestamp() - last_heartbeat_at <= ${ACTIVE_SESSION_INTERVAL}
      order by last_heartbeat_at desc
      limit 1
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
      pending_patches: presence?.pending?.filter((queued) => queued.state !== 'dead').length ?? 0,
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
): { kept: NoteRefineQueueEntry[]; dropped: number } {
  const kept: NoteRefineQueueEntry[] = [];
  let dropped = 0;
  let retainedPastTtl = 0;
  for (const item of pending) {
    let entry: NoteRefineQueueEntry;
    if (item.state === undefined) {
      const { drainStarted, ...payload } = item;
      entry = { ...payload, state: drainStarted ? 'draining' : 'pending' };
    } else {
      entry = item;
    }
    const pastTtl = now.getTime() - entry.queuedAtMs > EDITING_FORCE_APPLY_TIMEOUT_MS;
    // Neither retry obligations nor dead-letter evidence may expire as pending work.
    if (entry.state === 'pending' && entry.actorRef !== HUB_AUTO_SYNC_ACTOR_REF && pastTtl) {
      dropped++;
    } else {
      if (pastTtl && entry.state !== 'dead' && entry.actorRef === HUB_AUTO_SYNC_ACTOR_REF) {
        retainedPastTtl++;
      }
      kept.push(entry);
    }
  }
  if (dropped > 0) {
    console.warn(
      `[PgPresenceStore] dropped ${dropped} stale pending patch(es) for artifact ${artifactId} (age > ${EDITING_FORCE_APPLY_TIMEOUT_MS}ms)`,
    );
  }
  // Visibility for the intentional TTL exemption (YUK-768): only emitted when a
  // hub_auto_sync patch is actually retained past the ceiling — normal pruning
  // (no over-TTL hub patch) stays silent, so this never adds noise to the
  // high-frequency common path.
  if (retainedPastTtl > 0) {
    console.info(
      `[PgPresenceStore] retained ${retainedPastTtl} ${HUB_AUTO_SYNC_ACTOR_REF} pending patch(es) past the ${EDITING_FORCE_APPLY_TIMEOUT_MS}ms force-apply ceiling for artifact ${artifactId} (exempt from stale pruning)`,
    );
  }
  return { kept, dropped };
}
