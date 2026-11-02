// Postgres-backed editing presence store.
//
// Two tables, two concerns:
//   1. `artifact_edit_session` — heartbeat row per (artifact, editor session),
//      driving the isArtifactIdle decision. Heartbeat/blur upsert/delete under the
//      shared per-artifact advisory lock, serializing with hub-sync finalize.
//      Active = last heartbeat ≤ 30s (exactly 30s still active). There is no
//      10-minute forced apply: an abandoned session expires after 30s, making its
//      queued work eligible for a later flush.
//   2. `editing_presence.pending` — note-refine defer queue. Patches queue while
//      editing and flush FIFO once no session remains; whether to defer is driven
//      by session presence above. Stale entries (> 10min) are dropped at load with
//      a warning; entries already draining survive until apply + dequeue commits.
//
// Atomicity: the drain body, events, and per-item dequeue share a transaction, so
// a failure/exit never clears the remaining obligations.
// jsonb `pending` comes back from drizzle as an array — never JSON.parse it.

import { eq, sql } from 'drizzle-orm';

import {
  type PersistNoteRefineApplyResult,
  persistNoteRefineApply,
} from '@/capabilities/notes/server/note-refine-apply';
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
  // so first-heartbeat/reconcile races serialize.
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
    // Only sessions within the 30s active window count as 'editing' — same fence as
    // isArtifactIdle — so an abandoned heartbeat row (browser crash → no blur, not
    // yet swept) does not make the snapshot falsely read 'editing'.
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

// 丢弃 queuedAtMs 距 now 超过 EDITING_FORCE_APPLY_TIMEOUT_MS 的项：PG 行不会自己
// 过期，故 load 时显式丢弃以保住 TTL 语义，并 warn 丢弃计数与 artifactId。
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
  // Visibility for the intentional TTL exemption: only emitted when a hub_auto_sync
  // patch is actually retained past the ceiling — normal pruning stays silent, so
  // this never adds noise to the high-frequency common path.
  if (retainedPastTtl > 0) {
    console.info(
      `[PgPresenceStore] retained ${retainedPastTtl} ${HUB_AUTO_SYNC_ACTOR_REF} pending patch(es) past the ${EDITING_FORCE_APPLY_TIMEOUT_MS}ms force-apply ceiling for artifact ${artifactId} (exempt from stale pruning)`,
    );
  }
  return { kept, dropped };
}
