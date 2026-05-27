import { eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';

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
const REGEN_SINGLETON_SECONDS = 6 * 60;
// YUK-101 (iter2 fix F4) — singletonKey window for `memory_event_ingest`.
// Within this window pg-boss collapses duplicate sends for the same
// `event_id` key into one job. Mirrors REGEN_SINGLETON_SECONDS. The proper
// idempotency fix (transactional outbox: event row carries ingest_at; a
// separate poller enqueues once) is captured in YUK-101 follow-up.
const INGEST_SINGLETON_SECONDS = 6 * 60;

type BossLike = {
  createQueue?(name: string): Promise<unknown>;
  work(name: string, ...args: unknown[]): Promise<unknown>;
  schedule(name: string, cron: string, data: object, options: object): Promise<unknown>;
  send(name: string, data: object, options?: object): Promise<string | null>;
};

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

export async function enqueueEventMemoryIngest(boss: Pick<BossLike, 'send'>, eventId: string) {
  // YUK-101 (iter2 fix F4) — singletonKey dedupes ingest jobs for the same
  // event id within INGEST_SINGLETON_SECONDS. Why:
  //   1. `writeEvent` retries (deterministic id → onConflictDoNothing no-op)
  //      re-enqueue the same event id; without singletonKey, each retry would
  //      ingest into Mem0 again (Mem0 add is not content-hash idempotent).
  //   2. Tx-rollback orphans: the enqueue commits independently of the caller
  //      tx; if the surrounding tx rolls back, the worker handler no-ops on
  //      the missing row. If the caller later retries writeEvent with the
  //      same id, the second enqueue collapses into the orphan singleton slot
  //      rather than producing a fresh duplicate.
  // singletonNextSlot is intentionally omitted — for ingest we want the
  // duplicate dropped, not queued for the next slot.
  await boss.send(
    MEMORY_EVENT_INGEST_QUEUE,
    { event_id: eventId },
    {
      singletonKey: `memory.ingest.${eventId}`,
      singletonSeconds: INGEST_SINGLETON_SECONDS,
    },
  );
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
}
