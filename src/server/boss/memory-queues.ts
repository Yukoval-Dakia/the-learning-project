// Mounts the Agency memory pipeline's own queues and crons. They stay out of the manifest path so
// they keep their place in registerHandlers, ahead of every capability job.
import type { Job, PgBoss } from 'pg-boss';
import {
  type GenerateBrief,
  MEMORY_EVENT_INGEST_QUEUE,
  MEMORY_INFRA_SCHEDULES,
  MEMORY_INGEST_OUTBOX_POLL_QUEUE,
  MEMORY_INGEST_OUTBOX_RECOVER_QUEUE,
  buildBriefGenerator,
  buildContextPurposeRepairHandler,
  buildMemoryEventIngestHandler,
  buildMemoryIngestOutboxPollHandler,
  buildMemoryIngestOutboxRecoverHandler,
} from '@/capabilities/agency/public';
import type { Db } from '@/db/client';

const CONTEXT_PURPOSE_REPAIR_QUEUE = 'context_purpose_repair';

import type { MemoryClient } from '@/server/ai/mem0/client';
import {
  EXPIRE_LLM,
  FAST_QUEUE_OPTS,
  createJobQueue,
  createOrUpdateQueue,
} from '@/server/boss/queue-config';
import { fenceAwareJobHandler } from '@/server/migration/contract-epoch/boss-fence';

export async function registerMemoryHandlers(
  boss: PgBoss,
  db: Db,
  deps: {
    memoryClient?: MemoryClient;
    generateBrief?: GenerateBrief;
  } = {},
): Promise<void> {
  await boss.unschedule('memory_brief_sweep');
  const generateBrief = deps.generateBrief ?? buildBriefGenerator({ db });

  // Ingest runs mem0's extraction + embedding, so give it the shared LLM expiry
  // policy and a DLQ instead of pg-boss defaults.
  await createJobQueue(boss, MEMORY_EVENT_INGEST_QUEUE, EXPIRE_LLM);
  await boss.work(
    MEMORY_EVENT_INGEST_QUEUE,
    { pollingIntervalSeconds: 2, batchSize: 1 },
    // Epoch-agnostic per-delivery fence (drain disposition).
    fenceAwareJobHandler<Job<{ event_id: string }>>(
      db,
      MEMORY_EVENT_INGEST_QUEUE,
      buildMemoryEventIngestHandler(db, boss, { memoryClient: deps.memoryClient }),
    ),
  );

  await createJobQueue(boss, CONTEXT_PURPOSE_REPAIR_QUEUE, EXPIRE_LLM);
  await boss.work(
    CONTEXT_PURPOSE_REPAIR_QUEUE,
    { pollingIntervalSeconds: 2, batchSize: 1 },
    fenceAwareJobHandler(
      db,
      CONTEXT_PURPOSE_REPAIR_QUEUE,
      buildContextPurposeRepairHandler(db, { memoryClient: deps.memoryClient, generateBrief }),
    ),
  );

  // Upgrade drain only: ordinary legacy regeneration commands are discarded.
  // Bound purpose commands retain their original job id and once-only reservation.
  await createJobQueue(boss, 'memory_brief_regen', EXPIRE_LLM);
  const legacyPurposeHandler = buildContextPurposeRepairHandler(db, {
    memoryClient: deps.memoryClient,
    generateBrief,
  });
  await boss.work<{ scope_key: string; purpose_operation_id?: string }>(
    'memory_brief_regen',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    fenceAwareJobHandler(db, 'memory_brief_regen', async (jobs) => {
      await legacyPurposeHandler(jobs.filter((job) => Boolean(job.data.purpose_operation_id)));
    }),
  );

  await createOrUpdateQueue(boss, MEMORY_INGEST_OUTBOX_POLL_QUEUE, FAST_QUEUE_OPTS);
  await boss.work(
    MEMORY_INGEST_OUTBOX_POLL_QUEUE,
    fenceAwareJobHandler(
      db,
      MEMORY_INGEST_OUTBOX_POLL_QUEUE,
      buildMemoryIngestOutboxPollHandler(db, boss),
    ),
  );
  await createOrUpdateQueue(boss, MEMORY_INGEST_OUTBOX_RECOVER_QUEUE, FAST_QUEUE_OPTS);
  await boss.work(
    MEMORY_INGEST_OUTBOX_RECOVER_QUEUE,
    fenceAwareJobHandler(
      db,
      MEMORY_INGEST_OUTBOX_RECOVER_QUEUE,
      buildMemoryIngestOutboxRecoverHandler(db, boss),
    ),
  );

  // Register the static cron table; registration and admin reads share it.
  for (const decl of MEMORY_INFRA_SCHEDULES) {
    await boss.schedule(decl.name, decl.cron, {}, { tz: decl.tz });
  }
}
