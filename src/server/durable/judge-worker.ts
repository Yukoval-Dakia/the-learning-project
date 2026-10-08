import { DBOS } from '@dbos-inc/dbos-sdk';
import type { PgBoss } from 'pg-boss';
import {
  buildLegacyJudgeHandler,
  executeJudgeWorkflow,
  reconcileJudgeAttempts,
} from '@/capabilities/practice/public';
import { JudgeWorkflowInput } from '@/core/schema/event/judge-operational-events';
import type { Db } from '@/db/client';
import type { JobDecl } from '@/kernel/manifest';
import {
  EXPIRE_LLM,
  FAST_QUEUE_OPTS,
  createJobQueue,
  createOrUpdateQueue,
} from '@/server/boss/queue-config';
import { fenceAwareJobHandler, waitForRunnableEpoch } from '@/server/contract-epoch';
import { JUDGE_DBOS_QUEUE, JUDGE_DBOS_WORKFLOW } from './judge-client';
import {
  JUDGE_FAMILY,
  JUDGE_RECONCILE_FAMILY,
  installJudgeProducerFence,
  readJudgeFamilyControl,
} from './judge-family';

export type JudgeWorkerBoundary = (event: {
  kind: 'worker-entry' | 'domain-committed' | 'checkpoint-saved';
  workflowId: string;
}) => Promise<void>;
export function registerJudgeWorkflows(db: Db, boundary: JudgeWorkerBoundary = async () => {}) {
  const execute = DBOS.registerWorkflow(
    async (untrusted: unknown) => {
      const input = JudgeWorkflowInput.parse(untrusted),
        workflowId = DBOS.workflowID;
      if (workflowId !== input.delivery_id) throw new Error('Judge workflow ID/input mismatch');
      const result = await DBOS.runStep(
        async () => {
          await waitForRunnableEpoch(db);
          await boundary({ kind: 'worker-entry', workflowId });
          const outcome = await executeJudgeWorkflow(db, input);
          await boundary({ kind: 'domain-committed', workflowId });
          return outcome;
        },
        { name: 'native-judge-operation-v1', retriesAllowed: false },
      );
      await boundary({ kind: 'checkpoint-saved', workflowId });
      return result;
    },
    { name: JUDGE_DBOS_WORKFLOW, maxRecoveryAttempts: 100 },
  );
  const reconcile = DBOS.registerWorkflow(
    async (scheduledAt: Date, _context: unknown) => {
      const workflowId = DBOS.workflowID;
      if (
        !(scheduledAt instanceof Date) ||
        !Number.isFinite(scheduledAt.getTime()) ||
        workflowId !== `sched-${JUDGE_RECONCILE_FAMILY}-${scheduledAt.toISOString()}`
      )
        throw new Error('Judge reconcile schedule input invalid');
      await DBOS.runStep(
        () =>
          reconcileJudgeAttempts(db, {
            now: scheduledAt,
            tick: { backend: 'dbos', id: workflowId },
          }),
        { name: 'judge-pending-sweep-v1', retriesAllowed: false },
      );
    },
    { name: 'judge-pending-reconcile-v1', maxRecoveryAttempts: 100 },
  );
  return { execute, reconcile };
}
export async function prepareJudgeBackend(boss: PgBoss, db: Db) {
  await createJobQueue(boss, JUDGE_FAMILY, EXPIRE_LLM);
  await createOrUpdateQueue(boss, JUDGE_RECONCILE_FAMILY, FAST_QUEUE_OPTS);
  await installJudgeProducerFence(db);
}
/** The existing host owns the only lifecycle and timer. This adapter switches both judge declarations together. */
export function createJudgeBackend(args: {
  boss: PgBoss;
  db: Db;
  runDecl: JobDecl;
  reconcileDecl: JobDecl;
  workflows: ReturnType<typeof registerJudgeWorkflows>;
}) {
  const { boss, db, runDecl, reconcileDecl, workflows } = args,
    schedule = reconcileDecl.schedule;
  if (
    runDecl.name !== JUDGE_FAMILY ||
    runDecl.queue !== 'llm' ||
    runDecl.schedule ||
    runDecl.load ||
    runDecl.backend !== 'dbos' ||
    reconcileDecl.name !== JUDGE_RECONCILE_FAMILY ||
    reconcileDecl.queue !== 'fast' ||
    !schedule ||
    reconcileDecl.load ||
    reconcileDecl.backend !== 'dbos'
  )
    throw new Error('Invalid judge family declaration');
  let mounted = false,
    queueRegistered = false;
  return {
    async reconcile() {
      if (!queueRegistered) {
        await DBOS.registerQueue(JUDGE_DBOS_QUEUE, { concurrency: 1, workerConcurrency: 1 });
        queueRegistered = true;
      }
      const control = await readJudgeFamilyControl(db);
      if (control.phase === 'dbos') {
        await boss.unschedule(JUDGE_RECONCILE_FAMILY);
        await DBOS.applySchedules([
          {
            scheduleName: JUDGE_RECONCILE_FAMILY,
            workflowFn: workflows.reconcile,
            schedule: schedule.cron,
            cronTimezone: schedule.tz,
            automaticBackfill: false,
          },
        ]);
        await DBOS.resumeSchedule(JUDGE_RECONCILE_FAMILY);
        // External scheduler operations cannot share the control transaction. A drain that
        // raced the resume must pause it again; tick admission independently checks epoch.
        const after = await readJudgeFamilyControl(db);
        if (
          after.phase !== 'dbos' ||
          after.epoch !== control.epoch ||
          after.incarnation !== control.incarnation
        )
          await DBOS.pauseSchedule(JUDGE_RECONCILE_FAMILY);
      } else if (await DBOS.getSchedule(JUDGE_RECONCILE_FAMILY))
        await DBOS.pauseSchedule(JUDGE_RECONCILE_FAMILY);
      if (control.phase === 'pg-boss' || control.phase === 'draining-pg-boss') {
        if (!mounted) {
          await boss.work(
            JUDGE_FAMILY,
            { pollingIntervalSeconds: 2, batchSize: 1, includeMetadata: true },
            fenceAwareJobHandler(db, JUDGE_FAMILY, await buildLegacyJudgeHandler(db)),
          );
          await boss.work(
            JUDGE_RECONCILE_FAMILY,
            { pollingIntervalSeconds: 2, batchSize: 1 },
            fenceAwareJobHandler(db, JUDGE_RECONCILE_FAMILY, async (jobs) => {
              for (const job of jobs)
                await reconcileJudgeAttempts(db, { tick: { backend: 'pg-boss', id: job.id } });
            }),
          );
          mounted = true;
        }
      } else if (mounted) {
        await boss.offWork(JUDGE_FAMILY, { wait: false });
        await boss.offWork(JUDGE_RECONCILE_FAMILY, { wait: false });
        mounted = false;
      }
      if (control.phase === 'pg-boss')
        await boss.schedule(
          JUDGE_RECONCILE_FAMILY,
          schedule.cron,
          {},
          {
            tz: schedule.tz,
            ...(schedule.singletonKey !== undefined
              ? { singletonKey: schedule.singletonKey, singletonSeconds: schedule.singletonSeconds }
              : {}),
          },
        );
      else await boss.unschedule(JUDGE_RECONCILE_FAMILY);
    },
    async stop() {
      if (mounted) {
        await boss.offWork(JUDGE_FAMILY, { wait: false });
        await boss.offWork(JUDGE_RECONCILE_FAMILY, { wait: false });
        mounted = false;
      }
    },
  };
}
