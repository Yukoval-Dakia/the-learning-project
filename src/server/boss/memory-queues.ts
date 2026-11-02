// Mounts the Agency memory pipeline's own queues and crons. They stay out of the manifest path so
// they keep their place in registerHandlers, ahead of every capability job.
import type { Job, PgBoss } from 'pg-boss';
import {
  type GenerateBrief,
  MEMORY_BRIEF_REGEN_QUEUE,
  MEMORY_BRIEF_SWEEP_QUEUE,
  MEMORY_EVENT_INGEST_QUEUE,
  MEMORY_INFRA_SCHEDULES,
  MEMORY_INGEST_OUTBOX_POLL_QUEUE,
  MEMORY_INGEST_OUTBOX_RECOVER_QUEUE,
  MEMORY_RECONCILE_QUEUE,
  type ReconcileMemInput,
  buildBriefGenerator,
  buildMemoryBriefRegenHandler,
  buildMemoryBriefSweepHandler,
  buildMemoryEventIngestHandler,
  buildMemoryIngestOutboxPollHandler,
  buildMemoryIngestOutboxRecoverHandler,
  buildMemoryReconcileHandler,
} from '@/capabilities/agency/public';
import type { Db } from '@/db/client';
import { MEMORY_BRIEF_SWEEP_JOB, eligibilityFor } from '@/kernel/nightly-eligibility';
import type { MemoryClient } from '@/server/ai/mem0/client';
import { judgeReconciliation } from '@/server/ai/mem0/reconcile-llm';
import {
  EXPIRE_LLM,
  FAST_QUEUE_OPTS,
  createJobQueue,
  createOrUpdateQueue,
} from '@/server/boss/queue-config';
import { fenceAwareJobHandler } from '@/server/migration/contract-epoch/boss-fence';
import { loadNightlyContext, noteEligibilitySkip } from '@/server/orchestration/nightly-signals';

async function reflectionBriefsOff(db: Db, now: Date): Promise<boolean> {
  try {
    const signals = (await loadNightlyContext(db, now, [MEMORY_BRIEF_SWEEP_JOB])).forJob(
      MEMORY_BRIEF_SWEEP_JOB,
    );
    const decision = eligibilityFor('reflection', signals);
    if (!decision.run) {
      noteEligibilitySkip(MEMORY_BRIEF_SWEEP_JOB, decision);
      return true;
    }
    return false;
  } catch (err) {
    console.error(
      '[eligibility] memory brief signal load failed; skipping global/meta this sweep',
      err,
    );
    return true;
  }
}

export async function registerMemoryHandlers(
  boss: PgBoss,
  db: Db,
  deps: {
    memoryClient?: MemoryClient;
    generateBrief?: GenerateBrief;
  } = {},
): Promise<void> {
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

  await createJobQueue(boss, MEMORY_BRIEF_REGEN_QUEUE, EXPIRE_LLM);
  await boss.work(
    MEMORY_BRIEF_REGEN_QUEUE,
    { pollingIntervalSeconds: 2, batchSize: 1 },
    fenceAwareJobHandler(
      db,
      MEMORY_BRIEF_REGEN_QUEUE,
      buildMemoryBriefRegenHandler(db, { memoryClient: deps.memoryClient, generateBrief }),
    ),
  );

  await createOrUpdateQueue(boss, MEMORY_BRIEF_SWEEP_QUEUE, FAST_QUEUE_OPTS);
  await boss.work(
    MEMORY_BRIEF_SWEEP_QUEUE,
    fenceAwareJobHandler(
      db,
      MEMORY_BRIEF_SWEEP_QUEUE,
      buildMemoryBriefSweepHandler(db, boss, reflectionBriefsOff),
    ),
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

  // Reconcile is event-driven and shares the hourly recovery floor. It is a paid
  // LLM queue, so it gets the same expiry policy as the other memory queues.
  await createJobQueue(boss, MEMORY_RECONCILE_QUEUE, EXPIRE_LLM);
  await boss.work(
    MEMORY_RECONCILE_QUEUE,
    { pollingIntervalSeconds: 2, batchSize: 1 },
    fenceAwareJobHandler<
      Job<{
        memories: ReconcileMemInput[];
        user_id: string;
        source_event_id?: string;
      }>
    >(
      db,
      MEMORY_RECONCILE_QUEUE,
      buildMemoryReconcileHandler(db, {
        memoryClient: deps.memoryClient,
        judge: judgeReconciliation,
      }),
    ),
  );
}
