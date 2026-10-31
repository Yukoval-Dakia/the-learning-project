// Mounts manifest jobs that declare a loader, and starts admitted DBOS jobs, which have none.
// A fast queue has no dead-letter queue. A missed housekeeping beat reruns on the next cron.
// Declared worker options win. Absent fields stay on the retired 2s/1 recipe.
// Jobs with no schedule mount first, so a cron sender finds its on-demand queue already created.

import type { PgBoss } from 'pg-boss';

import type { Db } from '@/db/client';
import type { CapabilityManifest, JobDecl, JobHandlerFactory } from '@/kernel/manifest';
import {
  EXPIRE_AGENT,
  EXPIRE_FAST,
  EXPIRE_LLM,
  FAST_QUEUE_OPTS,
  createJobQueue,
  createOrUpdateQueue,
} from '@/server/boss/queue-config';
import { fenceAwareJobHandler } from '@/server/contract-epoch';
import { startDurableWorker } from '@/server/durable/prune-worker';
import {
  eligibilitySkipOutput,
  loadNightlyContext,
  noteEligibilitySkip,
} from '@/server/orchestration/nightly-signals';

function withScheduledEligibility(
  db: Db,
  decl: JobDecl,
  handler: ReturnType<JobHandlerFactory>,
): ReturnType<JobHandlerFactory> {
  const decide = decl.schedule ? decl.eligibility : undefined;
  const before = decl.schedule ? decl.beforeEligibility : undefined;
  if (!decide && !before) return handler;
  return async (jobs) => {
    if (before) await before(db);
    if (!decide) return handler(jobs);
    const signals = (await loadNightlyContext(db, new Date(), [decl.name])).forJob(decl.name);
    const decision = decide(signals);
    if (!decision.run) {
      noteEligibilitySkip(decl.name, decision);
      return eligibilitySkipOutput(decl.name, signals, decision);
    }
    return handler(jobs);
  };
}

const EXPIRE_BY_QUEUE = {
  llm: EXPIRE_LLM,
  agent: EXPIRE_AGENT,
  fast: EXPIRE_FAST,
} as const;

async function mountJob(boss: PgBoss, db: Db, decl: JobDecl): Promise<void> {
  // Narrows load for the calls below. The caller already filtered empty loaders.
  if (!decl.load) return;

  if (decl.queue === 'fast') {
    await createOrUpdateQueue(boss, decl.name, {
      ...FAST_QUEUE_OPTS,
      ...(decl.heartbeatSeconds !== undefined ? { heartbeatSeconds: decl.heartbeatSeconds } : {}),
    });
  } else {
    await createJobQueue(boss, decl.name, EXPIRE_BY_QUEUE[decl.queue], {
      ...(decl.heartbeatSeconds !== undefined ? { heartbeatSeconds: decl.heartbeatSeconds } : {}),
    });
  }

  const factory = await decl.load();
  // A worker that missed shutdown is refused on each delivery after the epoch flips.
  // Disposition lives in src/server/contract-epoch/jobs.ts.
  // DAG members have no schedule. Their eligibility runs before orchestrator send.
  // This wrap covers only a bare cron.
  const handler = withScheduledEligibility(db, decl, factory(db));
  await boss.work(
    decl.name,
    {
      pollingIntervalSeconds: decl.pollingIntervalSeconds ?? 2,
      batchSize: decl.batchSize ?? 1,
      ...(decl.includeMetadata !== undefined ? { includeMetadata: decl.includeMetadata } : {}),
    },
    fenceAwareJobHandler(db, decl.name, handler),
  );

  if (decl.schedule) {
    if (
      (decl.schedule.singletonKey === undefined) !==
      (decl.schedule.singletonSeconds === undefined)
    ) {
      throw new Error(
        `job ${decl.name} schedule must declare singletonKey and singletonSeconds together`,
      );
    }
    await boss.schedule(
      decl.name,
      decl.schedule.cron,
      {},
      {
        tz: decl.schedule.tz,
        ...(decl.schedule.singletonKey !== undefined
          ? {
              singletonKey: decl.schedule.singletonKey,
              singletonSeconds: decl.schedule.singletonSeconds,
            }
          : {}),
      },
    );
  }
}

const COACH_JOBS = new Set(['coach_daily', 'coach_weekly']);
const INTERVENTION_RECOVERY_JOB = 'intervention_prepare_recovery';

// Coach reads the kernel plan projection. Practice owns the due/budget/pace
// facts and binds them here, before any coach handler is mounted. Kernel
// read-models cannot import that capability.
async function installCoachDailyReviewPlan(capabilities: CapabilityManifest[]): Promise<void> {
  const coaches = capabilities.some((capability) =>
    (capability.jobs?.handlers ?? []).some((handler) => COACH_JOBS.has(handler.name)),
  );
  if (!coaches) return;
  const { installDailyReviewPlanFacts } = await import('@/capabilities/practice/public');
  await installDailyReviewPlanFacts();
}

// Archive recovery calls the kernel materializer. Practice owns FSRS enrollment
// and judge-run activity and installs those leaves here, before that handler runs.
async function installInterventionRecoveryMaterializer(
  capabilities: CapabilityManifest[],
): Promise<void> {
  const recovers = capabilities.some((capability) =>
    (capability.jobs?.handlers ?? []).some((handler) => handler.name === INTERVENTION_RECOVERY_JOB),
  );
  if (!recovers) return;
  const { installInterventionDiagnosticMaterializer } = await import(
    '@/capabilities/practice/public'
  );
  await installInterventionDiagnosticMaterializer();
}

// prepare_intervention runs the kernel author sequence. Practice owns the paid
// author and review stages and binds them here, before that handler can run.
async function installPrepareInterventionAuthor(capabilities: CapabilityManifest[]): Promise<void> {
  const prepares = capabilities.some((capability) =>
    (capability.jobs?.handlers ?? []).some((handler) => handler.name === 'prepare_intervention'),
  );
  if (!prepares) return;
  const { installInterventionAuthorStages } = await import('@/capabilities/practice/public');
  await installInterventionAuthorStages();
}

/** Called after registerHandlers. Chain targets in that book must already exist. */
export async function registerCapabilityJobs(
  boss: PgBoss,
  db: Db,
  capabilities: CapabilityManifest[],
): Promise<void> {
  await installCoachDailyReviewPlan(capabilities);
  await installInterventionRecoveryMaterializer(capabilities);
  await installPrepareInterventionAuthor(capabilities);
  const decls = capabilities
    .flatMap((cap) => cap.jobs?.handlers ?? [])
    .filter((d) => d.load || d.backend === 'dbos');
  const durable = decls.filter((d) => d.backend === 'dbos');
  const names = new Set<string>();
  for (const decl of durable) {
    if (
      names.has(decl.name) ||
      ![
        'prune_job_events',
        'prune_orphan_review_sessions',
        'prune_orphan_conversation_sessions',
        'prune_orphan_placement_sessions',
        'judge_run',
        'judge_pending_reconcile',
      ].includes(decl.name) ||
      decl.queue !== (decl.name === 'judge_run' ? 'llm' : 'fast') ||
      (decl.name === 'judge_run' ? !!decl.schedule : !decl.schedule) ||
      decl.load ||
      (decl.schedule && (!decl.schedule.cron.trim() || !decl.schedule.tz.trim())) ||
      (decl.name !== 'judge_pending_reconcile' &&
        (decl.schedule?.singletonKey !== undefined ||
          decl.schedule?.singletonSeconds !== undefined))
    )
      throw new Error(`Invalid or duplicate admitted DBOS family ${decl.name}`);
    names.add(decl.name);
  }
  const pruneEvents = durable.find((d) => d.name === 'prune_job_events');
  const reviewOrphans = durable.find((d) => d.name === 'prune_orphan_review_sessions');
  const conversationOrphans = durable.find((d) => d.name === 'prune_orphan_conversation_sessions');
  const placementOrphans = durable.find((d) => d.name === 'prune_orphan_placement_sessions');
  const judgeRun = durable.find((d) => d.name === 'judge_run');
  const judgeReconcile = durable.find((d) => d.name === 'judge_pending_reconcile');
  if (!!judgeRun !== !!judgeReconcile)
    throw new Error('Judge execution and reconciliation require paired ownership');
  if (
    durable.length &&
    (!pruneEvents || !reviewOrphans || !conversationOrphans || !placementOrphans)
  )
    throw new Error('Production DBOS admission requires the complete four-family set');
  const ordinary = decls.filter((d) => d.backend !== 'dbos');
  // Chain targets retain their existing order; complete admission was validated before any mounting.
  for (const decl of ordinary.filter((d) => !d.schedule)) await mountJob(boss, db, decl);
  if (pruneEvents && reviewOrphans && conversationOrphans && placementOrphans)
    await startDurableWorker({
      boss,
      db,
      declarations: {
        pruneEvents,
        reviewOrphans,
        conversationOrphans,
        placementOrphans,
        judgeRun,
        judgeReconcile,
      },
    });
  for (const decl of ordinary.filter((d) => d.schedule)) await mountJob(boss, db, decl);
}
