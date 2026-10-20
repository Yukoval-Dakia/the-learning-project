// Orchestrator mount point, called once by start-worker.ts after capability jobs:
// queue, two-state worker, single anchor cron. It owns a queue/cron and needs the
// boss dependency, so it has its own mounter instead of joining handlers.ts.

import type { Job, PgBoss } from 'pg-boss';

import type { Db } from '@/db/client';
import type { JobDag } from '@/kernel/job-dag';
import type { CapabilityManifest } from '@/kernel/manifest';
import { EXPIRE_FAST, createJobQueue } from '@/server/boss/queue-config';
import { fenceAwareJobHandler } from '@/server/contract-epoch';
import { ORCHESTRATOR_CRON, ORCHESTRATOR_QUEUE, ORCHESTRATOR_TZ } from './constants';
import { buildOrchestrationDag } from './members';
import {
  type OrchestratorBoss,
  runOrchestratorCatchUp,
  runOrchestratorStart,
  runOrchestratorTick,
} from './orchestrator';

/** Cron `{}`, tick `{tick:true, runId?}`, or manual `{trigger:'manual'}`. */
export interface OrchestratorJobPayload {
  tick?: true;
  runId?: string;
  trigger?: 'manual';
}

/**
 * Production adapter, named so tests can exercise it. An inline object was invisible
 * to tests; FakeBoss passed output through while production dropped it.
 */
export function toOrchestratorBoss(boss: PgBoss): OrchestratorBoss {
  return {
    send: (name, data, options) => boss.send(name, data, options ?? {}),
    getJobById: async (name, id) => {
      const job = await boss.getJobById(name, id);
      // Losing this passthrough silently breaks the nightly yield report chain.
      return job ? { state: job.state, output: job.output } : null;
    },
    // v12 returns an affected-row response; the narrow interface needs only best effort.
    cancel: async (name, id) => {
      await boss.cancel(name, id);
    },
  };
}

/**
 * Allows exactly `{}`, `{tick:true, runId?}`, or `{trigger:'manual'}`. A loose parser
 * would treat `{tick:false}` as cron and rerun every paid root.
 */
export function parseOrchestratorPayload(raw: unknown): OrchestratorJobPayload {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `[orchestrator] unexpected job payload (not an object): ${JSON.stringify(raw)}`,
    );
  }
  const allowed = new Set(['tick', 'runId', 'trigger']);
  const unknown = Object.keys(raw as Record<string, unknown>).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw new Error(`[orchestrator] unexpected job payload key(s): ${unknown.join(', ')}`);
  }
  const { tick, runId, trigger } = raw as Record<string, unknown>;
  if (tick !== undefined && tick !== true) {
    throw new Error(
      `[orchestrator] unexpected job payload: 'tick' must be exactly true, got ${JSON.stringify(tick)}`,
    );
  }
  if (trigger !== undefined && trigger !== 'manual') {
    throw new Error(
      `[orchestrator] unexpected job payload: 'trigger' must be exactly 'manual', got ${JSON.stringify(trigger)}`,
    );
  }
  if (tick !== undefined && trigger !== undefined) {
    throw new Error(
      "[orchestrator] unexpected job payload: 'tick' and 'trigger' are mutually exclusive",
    );
  }
  if (runId !== undefined && (typeof runId !== 'string' || runId.length === 0)) {
    throw new Error(
      `[orchestrator] unexpected job payload: 'runId' must be a non-empty string, got ${JSON.stringify(runId)}`,
    );
  }
  // runId is only valid on a tick; reject it elsewhere rather than guessing.
  if (runId !== undefined && tick !== true) {
    throw new Error("[orchestrator] unexpected job payload: 'runId' is only valid with tick:true");
  }
  if (tick === true) return runId === undefined ? { tick: true } : { tick: true, runId };
  if (trigger === 'manual') return { trigger: 'manual' };
  return {};
}

/**
 * Creates the orchestrator queue and its dead-letter queue. FAST_QUEUE_OPTS inherits
 * retryDelay 0 and no DLQ, which burns every attempt during the outage and leaves no
 * remains when "last night did not run".
 *
 * createJobQueue creates `<name>_dlq` first (the main queue references it by FK),
 * then retry 30s/backoff/DLQ; createOrUpdateQueue also lands it on existing queues.
 */
export async function ensureOrchestratorQueues(boss: PgBoss): Promise<void> {
  await createJobQueue(boss, ORCHESTRATOR_QUEUE, EXPIRE_FAST);
}

/** A second mount would add a second boss.work consumer and double the night. */
let mounted = false;

/** Test hook: resets the in-process mount gate. */
export function resetOrchestratorMountForTest(): void {
  mounted = false;
}

export async function registerOrchestrator(
  boss: PgBoss,
  db: Db,
  capabilities: readonly CapabilityManifest[],
): Promise<void> {
  if (mounted) {
    console.warn(
      '[orchestrator] already mounted in this process — skipping duplicate registration',
    );
    return;
  }
  const dag = buildOrchestrationDag(capabilities);
  if (dag.nodes.size === 0) {
    // No declared members: do not mount a cron that can never run.
    console.log('[orchestrator] no DAG members declared — not mounted');
    return;
  }
  // Gate after success; a first-set would lock out retries after a throw.
  mounted = true;
  try {
    await mountOrchestrator(boss, db, dag);
  } catch (err) {
    mounted = false;
    throw err;
  }
}

// Removed from the manifest, but old databases may still have their schedules.
const RETIRED_BARE_CRONS = ['kt_estimate_nightly', 'axis_state_nightly'] as const;

async function unscheduleRetiredCrons(boss: PgBoss): Promise<void> {
  for (const name of RETIRED_BARE_CRONS) {
    await boss.unschedule(name);
    try {
      // Queued jobs have no consumer. Active ones are left to the queue expire.
      await boss.deleteQueuedJobs(name);
    } catch (err) {
      if (err instanceof Error && err.message === `Queue ${name} does not exist`) continue;
      throw err;
    }
  }
}

/**
 * Order: queues -> clear schedules -> anchor -> boss.work last. A registered consumer
 * has no rollback; a retry would add a second one and double the paid night.
 */
async function mountOrchestrator(boss: PgBoss, db: Db, dag: JobDag): Promise<void> {
  await ensureOrchestratorQueues(boss);

  // Clear pre-migration cron rows or they bypass the dependency gate. Any failure
  // aborts the mount; keeping the anchor would double-run paid jobs.
  const members = [...dag.nodes.keys()];
  const unscheduled = await Promise.allSettled(members.map((member) => boss.unschedule(member)));
  const failedUnschedules = members.filter((_, i) => unscheduled[i].status === 'rejected');
  for (const [i, result] of unscheduled.entries()) {
    if (result.status === 'rejected') {
      console.error(
        `[orchestrator] failed to unschedule legacy cron for DAG member '${members[i]}'`,
        result.reason,
      );
    }
  }
  if (failedUnschedules.length > 0) {
    throw new Error(
      `[orchestrator] aborting mount: could not clear legacy cron for ${failedUnschedules.length} DAG member(s) (${failedUnschedules.join(', ')}); mounting the anchor now would let them both self-fire and be orchestrated (duplicate paid jobs, dependency gate bypassed)`,
    );
  }

  await unscheduleRetiredCrons(boss);

  // Single anchor cron; members carry none (validateComposition enforces it).
  await boss.schedule(ORCHESTRATOR_QUEUE, ORCHESTRATOR_CRON, {}, { tz: ORCHESTRATOR_TZ });

  const orchestratorBoss: OrchestratorBoss = toOrchestratorBoss(boss);

  // Last step: register the consumer (see the ordering note above).
  await boss.work(
    ORCHESTRATOR_QUEUE,
    { pollingIntervalSeconds: 2, batchSize: 1 },
    // Native Job type catches pg-boss shape changes; payload is narrowed separately.
    fenceAwareJobHandler(db, ORCHESTRATOR_QUEUE, async (jobs: Job[]) => {
      for (const job of jobs) {
        // Log then rethrow every path. A normal return means the run settled or the next
        // tick is queued; an exception means the chain was never armed, so redelivery is
        // the only recovery. Armed-chain failures are swallowed inside.
        try {
          // Parse inside the try so malformed manual enqueues are logged too.
          const data = parseOrchestratorPayload(job.data);
          if (data.tick) {
            await runOrchestratorTick({ db, boss: orchestratorBoss, dag }, data.runId);
          } else {
            // Empty payload = cron anchor; manual reruns the whole chain.
            await runOrchestratorStart(
              { db, boss: orchestratorBoss, dag },
              data.trigger === 'manual' ? 'manual' : 'cron',
            );
          }
        } catch (err) {
          console.error('[orchestrator] job failed — rethrowing for pg-boss redelivery', err);
          throw err;
        }
      }
    }),
  );

  console.log(
    `[orchestrator] mounted: ${dag.nodes.size} members / ${dag.roots.length} roots; anchor cron ${ORCHESTRATOR_CRON} ${ORCHESTRATOR_TZ}`,
  );

  // After boss.work: catch-up enqueues the first tick. Its guards live in
  // runOrchestratorCatchUp; this catch cannot block boot.
  try {
    await runOrchestratorCatchUp({ db, boss: orchestratorBoss, dag });
  } catch (err) {
    console.error('[orchestrator] boot catch-up threw unexpectedly (non-fatal)', err);
  }
}
