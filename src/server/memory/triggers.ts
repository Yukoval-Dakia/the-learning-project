import { eq, inArray, isNull, sql } from 'drizzle-orm';
import { type DrizzleTransactionLike, type Job, fromDrizzle } from 'pg-boss';

import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { BRIEF_REFRESH_BUDGET } from '@/server/ai/tools/budgets';
import {
  listActiveSubjectsSinceRefresh,
  loadSubjectBriefEvents,
  selectSubjectsForRun,
  subjectScopeHasNewEvidence,
} from './active-subjects';
import {
  type GenerateBrief,
  listStaleBriefScopes,
  regenerateMemoryBrief,
  scopeHasNewEvidence,
} from './brief';
import { type MemoryClient, type MemoryEventInput, createMemoryClient } from './client';

// P5.2 (YUK-143) — per-subject brief refresh lookback for the nightly sweep +
// regen handler. Bounded initial-build window for never-built subjects (BR-5).
const BRIEF_REFRESH_LOOKBACK_DAYS = 30;
const SUBJECT_SCOPE_PREFIX = 'subject:';

export const MEMORY_EVENT_INGEST_QUEUE = 'memory_event_ingest';
export const MEMORY_BRIEF_REGEN_QUEUE = 'memory_brief_regen';
export const MEMORY_BRIEF_SWEEP_QUEUE = 'memory_brief_sweep';
// ADR-0021 outbox queues. Poller fires every minute (pg-boss cron minimum);
// recovery sweep hourly is unbounded and catches anything the poller missed
// (e.g., worker restart, single fast-burst > batch size).
export const MEMORY_INGEST_OUTBOX_POLL_QUEUE = 'memory_ingest_outbox_poll';
export const MEMORY_INGEST_OUTBOX_RECOVER_QUEUE = 'memory_ingest_outbox_recover';
const OUTBOX_POLL_BATCH = 50;
const REGEN_SINGLETON_SECONDS = 6 * 60;

type BossLike = {
  createQueue?(name: string): Promise<unknown>;
  work(name: string, ...args: unknown[]): Promise<unknown>;
  schedule(name: string, cron: string, data: object, options: object): Promise<unknown>;
  send(name: string, data: object, options?: object): Promise<string | null>;
};

type ProjectDrizzleTx = {
  execute(query: unknown): Promise<unknown>;
};

function hasRowsResult(value: unknown): value is { rows: unknown[] } {
  return (
    typeof value === 'object' && value !== null && Array.isArray((value as { rows?: unknown }).rows)
  );
}

function fromPgBossDrizzleTx(tx: ProjectDrizzleTx) {
  // pg-boss's Drizzle adapter expects node-postgres-style `{ rows }`, while
  // this repo uses drizzle-orm/postgres-js where `execute()` returns the row
  // array directly. Normalize only this driver shape before handing it to
  // pg-boss so `send(..., { db })` stays in the caller transaction.
  const txWithRows: DrizzleTransactionLike = {
    async execute(query) {
      const result = await tx.execute(query);
      if (Array.isArray(result)) return { rows: result };
      if (hasRowsResult(result)) return result;
      throw new Error('pg-boss Drizzle tx adapter received an unsupported execute() result');
    },
  };
  return fromDrizzle(txWithRows, sql);
}

async function defaultLoadEvent(db: Db, eventId: string): Promise<MemoryEventInput | null> {
  const rows = await db.select().from(event).where(eq(event.id, eventId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    action: row.action,
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    payload: row.payload,
    affected_scopes: row.affected_scopes,
    created_at: row.created_at,
  };
}

// ADR-0021 — outbox poll handler is the sole producer. Dedup is enforced by
// the `ingest_at IS NULL` partition (a row is enqueued exactly once and the
// stamp commits in the same tx as the enqueue). singletonKey + the iter2
// band-aids it required (writeEvent inline retry collapse, tx-rollback orphan
// slot) are gone.
export async function enqueueEventMemoryIngest(
  boss: Pick<BossLike, 'send'>,
  eventId: string,
  options?: object,
) {
  await boss.send(MEMORY_EVENT_INGEST_QUEUE, { event_id: eventId }, options);
}

export async function enqueueBriefRegen(
  boss: Pick<BossLike, 'send'>,
  scopeKey: string,
  // P5.2 (PR #218 fix) — optional stable sweep timestamp (ISO). The subject
  // regen path floors its event reload at `now - lookbackDays` for a never-built
  // subject; threading the SWEEP's `now` (rather than letting regen re-read the
  // clock at job-run time) closes the race where an event near the 30d lookback
  // edge is detected at sweep time T but ages out by regen time T+δ. Global jobs
  // pass no `now` (global path is clock-independent / unchanged).
  now?: Date,
) {
  await boss.send(
    MEMORY_BRIEF_REGEN_QUEUE,
    now ? { scope_key: scopeKey, now: now.toISOString() } : { scope_key: scopeKey },
    {
      // singletonKey unchanged — per-scope dedup must still collapse the stale
      // loop's enqueue (if any) and the per-subject enqueue into one job.
      singletonKey: `memory.regen.${scopeKey}`,
      singletonSeconds: REGEN_SINGLETON_SECONDS,
      singletonNextSlot: true,
    },
  );
}

export function buildMemoryEventIngestHandler(
  db: Db,
  boss: Pick<BossLike, 'send'>,
  deps: {
    loadEvent?: (db: Db, eventId: string) => Promise<MemoryEventInput | null>;
    memoryClient?: MemoryClient;
  } = {},
): (jobs: Job<{ event_id: string }>[]) => Promise<void> {
  const loadEvent = deps.loadEvent ?? defaultLoadEvent;
  let memoryClient = deps.memoryClient;
  return async (jobs) => {
    memoryClient ??= createMemoryClient();
    const client = memoryClient;
    for (const job of jobs) {
      const row = await loadEvent(db, job.data.event_id);
      if (!row) continue;
      await client.addEventMemory(row);
      for (const scopeKey of row.affected_scopes) {
        await enqueueBriefRegen(boss, scopeKey);
      }
    }
  };
}

export function buildMemoryBriefRegenHandler(
  db: Db,
  deps: {
    memoryClient?: Pick<MemoryClient, 'search'>;
    generateBrief: GenerateBrief;
  },
): (jobs: Job<{ scope_key: string; now?: string }>[]) => Promise<void> {
  // F-4 (PR #232 review) — keep the injected test client here, but DO NOT init
  // the real Mem0 client at the top of the batch. `createMemoryClient()` throws
  // when its env (OPENAI_API_KEY / XIAOMI_API_KEY / DATABASE_URL for Mem0) is
  // missing; doing it before the per-scope try would reject the WHOLE pg-boss
  // job → nightly retry storm → the F-1 per-scope catch is defeated. Mem0
  // fact-search is SUPPLEMENTARY — brief regen must still run from events when
  // Mem0 is unavailable. The lazy `??= createMemoryClient()` now lives inside
  // searchFacts' own try (below) so a missing-Mem0-key degrades to facts=[].
  let memoryClient = deps.memoryClient;
  return async (jobs) => {
    for (const job of jobs) {
      const scopeKey = job.data.scope_key;
      // F-1 (YUK-185, D8): one scope's LLM/provider throw (e.g. resolveTaskProvider
      // throwing on a missing XIAOMI_API_KEY, providers.ts:88, or any runTask failure
      // inside the injected generateBrief) must NOT reject the pg-boss job and trigger
      // a nightly retry storm. The writer/generator stays LOUD (re-throws, never
      // persists a blank row); the graceful "log + leave old brief intact" posture
      // lives HERE. Catch per scope, log, continue — the prior brief row is never
      // overwritten because the upsert in regenerateMemoryBrief is only reached on
      // success. Mirrors knowledge_propose_nightly.ts:96-99 (per-job try/catch).
      try {
        const searchFacts = async () => {
          // F-4 (PR #232 review) — self-degrading. Lazily init the Mem0 client
          // HERE so a missing-key throw stays contained: missing Mem0 env →
          // facts=[] (brief still generates from events). A missing LLM key
          // instead throws later inside generateBrief, caught by the F-1
          // per-scope catch → logged skip. Neither path storms the job.
          try {
            memoryClient ??= createMemoryClient();
            const result = await memoryClient.search(`memory brief ${scopeKey}`, {
              topK: 10,
              filters: { scope_key: scopeKey },
            });
            return (result?.results ?? []).map((item) => ({ id: item.id, memory: item.memory }));
          } catch (err) {
            console.warn(
              `[memory_brief_regen] Mem0 fact search unavailable for ${scopeKey}; proceeding without facts`,
              err,
            );
            return [];
          }
        };

        // BR-10 (load-bearing) — branch by scope prefix. attempt/review events
        // never tag `subject:` in affected_scopes (§1.2), so the global path's
        // affected_scopes-based guard + loader return false / ~0 rows for an
        // active subject. The subject path instead reads a knowledge-resolved
        // event window (the SAME resolution as the activity-detection sweep) and
        // gates on a KNOWLEDGE-resolved freshness check — never the affected_scopes
        // one. The active-subject sweep already filtered to fresh subjects, and
        // (since PR #218 FIX 1) listStaleBriefScopes excludes `subject:*`, so the
        // stale loop no longer enqueues dormant subjects. The guard is retained as
        // defense-in-depth: a pg-boss singleton re-fire within the dedup window, or
        // a refreshed_at-vs-latest_evidence_at skew, could still hand this branch a
        // subject with no genuinely new evidence; the guard makes that a clean skip
        // (BR-2: no LLM call, no refreshed_at bump for a dormant subject).
        if (scopeKey.startsWith(SUBJECT_SCOPE_PREFIX)) {
          const subjectId = scopeKey.slice(SUBJECT_SCOPE_PREFIX.length);
          // P5.2 (PR #218 fix) — reuse the SWEEP's `now` (threaded via the job
          // payload) rather than re-reading the clock here. For a never-built
          // subject the floor is `now - lookbackDays`; if regen recomputed it with a
          // fresh clock at job-run time (T+δ), an event the sweep detected near the
          // 30d edge could age out → empty window → silent miss. Sharing the sweep's
          // `now` keeps detection and reload on the SAME floor. Falls back to a fresh
          // clock only if the job carries no `now` (e.g., a job from before this fix).
          const now = job.data.now ? new Date(job.data.now) : new Date();
          // loadSubjectBriefEvents floors at THIS subject's own brief refreshed_at
          // (lookbackDays only as the never-built fallback), the SAME
          // subjectEventFloor predicate the detection sweep uses — so any subject
          // the sweep flagged active reloads ≥1 event here and is never silently
          // starved by a flat now-30d floor.
          const events = await loadSubjectBriefEvents(db, subjectId, {
            lookbackDays: BRIEF_REFRESH_LOOKBACK_DAYS,
            now,
          });
          if (!(await subjectScopeHasNewEvidence(db, scopeKey, events))) continue;
          await regenerateMemoryBrief({
            db,
            scopeKey,
            loadEvents: async () => events,
            searchFacts,
            generate: deps.generateBrief,
          });
          continue;
        }

        // BR-6 — global (and any legacy affected_scopes-tagged scope): unchanged.
        // Still gated by scopeHasNewEvidence + loaded via loadEventsFromDb.
        if (!(await scopeHasNewEvidence(db, scopeKey))) continue;
        await regenerateMemoryBrief({
          db,
          scopeKey,
          searchFacts,
          generate: deps.generateBrief,
        });
      } catch (err) {
        // Leave the prior brief row intact (the upsert is only reached on success)
        // and move to the next scope — no rethrow, no pg-boss reject/retry storm.
        console.error(`[memory_brief_regen] scope ${scopeKey} failed; leaving prior brief`, err);
      }
    }
  };
}

export function buildMemoryBriefSweepHandler(
  db: Db,
  boss: Pick<BossLike, 'send'>,
  // P5.2 (PR #218 fix) — optional injected `now`. Computed ONCE per sweep and
  // shared across detection + the per-subject regen jobs it enqueues, so a
  // never-built subject's 30d lookback floor is identical at detection time and
  // reload time (closes the 30d-edge race; also makes fixed-NOW tests
  // deterministic regardless of wall-clock drift). Defaults to a fresh clock.
  opts?: { now?: Date },
): (jobs: Job<object>[]) => Promise<void> {
  return async () => {
    const now = opts?.now ?? new Date();

    // BR-6 — global + any existing stale (non-subject) brief rows: unchanged
    // 24h-stale gate. `listStaleBriefScopes` now EXCLUDES `subject:*` rows
    // (brief.ts), so subject refresh is owned entirely by the capped per-subject
    // path below and is never enqueued uncapped via this loop. The global brief
    // is always enqueued here and is NOT subject to maxSubjectsPerRun.
    for (const scopeKey of await listStaleBriefScopes(db, now)) {
      await enqueueBriefRegen(boss, scopeKey);
    }

    // P5.2 (YUK-143) — additive activity-gated per-subject layer (§3.3). Find
    // subjects whose knowledge-resolved activity is newer than their brief's
    // refreshed_at (or never-built within the lookback window), sort by activity
    // recency DESC, and enqueue only the top maxSubjectsPerRun (BR-9). Deferred
    // subjects remain active and are eligible again next run (no starvation).
    // enqueueBriefRegen dedups per scope_key on a 6-min singleton window.
    const activeSubjects = await listActiveSubjectsSinceRefresh(db, {
      lookbackDays: BRIEF_REFRESH_LOOKBACK_DAYS,
      now,
    });
    for (const subject of selectSubjectsForRun(
      activeSubjects,
      BRIEF_REFRESH_BUDGET.maxSubjectsPerRun,
    )) {
      // Thread the sweep's `now` so the regen job reloads on the SAME 30d floor.
      await enqueueBriefRegen(boss, subject.scopeKey, now);
    }
  };
}

// ADR-0021 — transactional outbox poll handler. Cron fires every minute;
// SELECT...FOR UPDATE SKIP LOCKED grabs a batch of pending event rows
// (`ingest_at IS NULL`), enqueues each into MEMORY_EVENT_INGEST_QUEUE, and
// stamps `ingest_at = now()` in the SAME transaction — so concurrent pollers
// never double-enqueue and a worker crash before commit reverts the stamp.
export function buildMemoryIngestOutboxPollHandler(
  db: Db,
  boss: Pick<BossLike, 'send'>,
): (jobs: Job<object>[]) => Promise<void> {
  return async () => {
    await db.transaction(async (tx) => {
      const pending = await tx
        .select({ id: event.id })
        .from(event)
        .where(isNull(event.ingest_at))
        .orderBy(event.created_at)
        .limit(OUTBOX_POLL_BATCH)
        .for('update', { skipLocked: true });
      if (pending.length === 0) return;
      for (const row of pending) {
        await enqueueEventMemoryIngest(boss, row.id, { db: fromPgBossDrizzleTx(tx) });
      }
      await tx
        .update(event)
        .set({ ingest_at: new Date() })
        .where(
          inArray(
            event.id,
            pending.map((r) => r.id),
          ),
        );
    });
  };
}

// ADR-0021 — recovery sweep. Hourly cron drains any pending rows the
// per-minute poller missed (worker outage, fast burst > batch limit).
// Calls the same per-batch poller in a loop until a cycle returns empty,
// with a safety cap to prevent runaway loops on pathological state.
const OUTBOX_RECOVER_MAX_CYCLES = 1000;
export function buildMemoryIngestOutboxRecoverHandler(
  db: Db,
  boss: Pick<BossLike, 'send'>,
): (jobs: Job<object>[]) => Promise<void> {
  const drainOnce = buildMemoryIngestOutboxPollHandler(db, boss);
  return async () => {
    for (let cycle = 0; cycle < OUTBOX_RECOVER_MAX_CYCLES; cycle += 1) {
      const before = await countPendingIngest(db);
      if (before === 0) return;
      await drainOnce([]);
      const after = await countPendingIngest(db);
      if (after >= before) return; // no progress — bail to avoid infinite loop
    }
  };
}

async function countPendingIngest(db: Db): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(event)
    .where(isNull(event.ingest_at));
  return rows[0]?.count ?? 0;
}

async function defaultGenerateBrief(): Promise<never> {
  throw new Error('memory brief LLM generator is not configured');
}

export async function registerMemoryHandlers(
  boss: BossLike,
  db: Db,
  deps: {
    memoryClient?: MemoryClient;
    generateBrief?: GenerateBrief;
  } = {},
): Promise<void> {
  const generateBrief = deps.generateBrief ?? defaultGenerateBrief;

  // F-2 (YUK-185) — the XIAOMI_API_KEY boot WARN used to live HERE, but tests
  // also call registerMemoryHandlers (with a stubbed generateBrief), so it
  // emitted a false "brief regen will fail" line in every such test. PR #232
  // review (FIX #6) moved the one-time WARN to the prod entry point
  // (scripts/worker.ts) — the only boot path that actually runs the cron — so
  // the operator still gets the signal and tests stay quiet.

  await boss.createQueue?.(MEMORY_EVENT_INGEST_QUEUE);
  await boss.work(
    MEMORY_EVENT_INGEST_QUEUE,
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildMemoryEventIngestHandler(db, boss, { memoryClient: deps.memoryClient }),
  );

  await boss.createQueue?.(MEMORY_BRIEF_REGEN_QUEUE);
  await boss.work(
    MEMORY_BRIEF_REGEN_QUEUE,
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildMemoryBriefRegenHandler(db, { memoryClient: deps.memoryClient, generateBrief }),
  );

  await boss.createQueue?.(MEMORY_BRIEF_SWEEP_QUEUE);
  await boss.work(MEMORY_BRIEF_SWEEP_QUEUE, buildMemoryBriefSweepHandler(db, boss));
  await boss.schedule(MEMORY_BRIEF_SWEEP_QUEUE, '0 3 * * *', {}, { tz: 'Asia/Shanghai' });

  // ADR-0021 outbox: per-minute poller drains pending ingest rows; hourly
  // recovery sweep catches anything missed (worker outage, batch overflow).
  await boss.createQueue?.(MEMORY_INGEST_OUTBOX_POLL_QUEUE);
  await boss.work(MEMORY_INGEST_OUTBOX_POLL_QUEUE, buildMemoryIngestOutboxPollHandler(db, boss));
  await boss.schedule(MEMORY_INGEST_OUTBOX_POLL_QUEUE, '* * * * *', {}, { tz: 'UTC' });

  await boss.createQueue?.(MEMORY_INGEST_OUTBOX_RECOVER_QUEUE);
  await boss.work(
    MEMORY_INGEST_OUTBOX_RECOVER_QUEUE,
    buildMemoryIngestOutboxRecoverHandler(db, boss),
  );
  await boss.schedule(MEMORY_INGEST_OUTBOX_RECOVER_QUEUE, '0 * * * *', {}, { tz: 'UTC' });
}
