import { eq, inArray, isNull, sql } from 'drizzle-orm';
import { type DrizzleTransactionLike, type Job, fromDrizzle } from 'pg-boss';

import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import {
  type GenerateBrief,
  listStaleBriefScopes,
  regenerateMemoryBrief,
  scopeHasNewEvidence,
} from './brief';
import { type MemoryClient, type MemoryEventInput, createMemoryClient } from './client';

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

export async function enqueueBriefRegen(boss: Pick<BossLike, 'send'>, scopeKey: string) {
  await boss.send(
    MEMORY_BRIEF_REGEN_QUEUE,
    { scope_key: scopeKey },
    {
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
): (jobs: Job<{ scope_key: string }>[]) => Promise<void> {
  let memoryClient = deps.memoryClient;
  return async (jobs) => {
    memoryClient ??= createMemoryClient();
    const client = memoryClient;
    for (const job of jobs) {
      const scopeKey = job.data.scope_key;
      if (!(await scopeHasNewEvidence(db, scopeKey))) continue;
      await regenerateMemoryBrief({
        db,
        scopeKey,
        searchFacts: async () => {
          const result = await client.search(`memory brief ${scopeKey}`, {
            topK: 10,
            filters: { scope_key: scopeKey },
          });
          return (result?.results ?? []).map((item) => ({ id: item.id, memory: item.memory }));
        },
        generate: deps.generateBrief,
      });
    }
  };
}

export function buildMemoryBriefSweepHandler(
  db: Db,
  boss: Pick<BossLike, 'send'>,
): (jobs: Job<object>[]) => Promise<void> {
  return async () => {
    for (const scopeKey of await listStaleBriefScopes(db)) {
      await enqueueBriefRegen(boss, scopeKey);
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
    .select({ id: event.id })
    .from(event)
    .where(isNull(event.ingest_at))
    .limit(OUTBOX_POLL_BATCH + 1);
  return rows.length;
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
