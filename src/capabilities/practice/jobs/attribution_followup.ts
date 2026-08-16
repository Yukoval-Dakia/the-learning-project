import type { Job } from 'pg-boss';
import { createFailureLearning } from '@/capabilities/practice/server/failure-learning';
import { getPracticeBoss } from '@/capabilities/practice/server/queue-runtime';
import {
  type PracticeTaskRunFn,
  makePracticeTaskRunFn,
} from '@/capabilities/practice/server/task-runtime';
import type { Db } from '@/db/client';
import {
  type FailureLearningBossSend,
  type FailureLearningJobData,
  enqueueVariantGen,
  failureLearningAttemptId,
} from './failure-learning-jobs';

export type AttributionFollowupJobData = FailureLearningJobData;

export type RunTaskFn = PracticeTaskRunFn;
export type EnqueueVariantGenFn = (attemptEventId: string) => Promise<void>;

type DepsOverride = {
  runTaskFn?: RunTaskFn;
  enqueueVariantGen?: EnqueueVariantGenFn;
};

async function defaultEnqueueVariantGen(attemptEventId: string): Promise<void> {
  const boss = await getPracticeBoss();
  await enqueueVariantGen(boss.send.bind(boss) as FailureLearningBossSend, attemptEventId);
}

export interface RunAttributionFollowupParams {
  db: Db;
  attemptEventId: string;
  runTaskFn: RunTaskFn;
  enqueueVariantGen: EnqueueVariantGenFn;
}

export interface RunAttributionFollowupResult {
  status:
    | 'attempted'
    | 'failed_permanent'
    | 'skipped:attempt_not_found'
    | 'skipped:not_a_failure_attempt'
    | 'skipped:attempt_not_active'
    | 'skipped:unsupported_judge'
    | 'skipped:user_cause_present'
    | 'skipped:question_not_found';
}

/**
 * Stable pg-boss payload adapter. Product eligibility, attribution, error
 * classification, and variant handoff ordering live in the owner facade.
 */
export async function runAttributionFollowup(
  params: RunAttributionFollowupParams,
): Promise<RunAttributionFollowupResult> {
  const learning = createFailureLearning({
    db: params.db,
    runTaskFn: params.runTaskFn,
    enqueueVariant: params.enqueueVariantGen,
  });
  const result = await learning.followUp({ attemptEventId: params.attemptEventId });

  if (result.status === 'failed_retryable') throw result.error;
  if (result.status === 'failed_permanent') return { status: 'failed_permanent' };
  if (result.status === 'handed_off') return { status: 'attempted' };
  return {
    status:
      result.reason === 'not_failure_attempt'
        ? 'skipped:not_a_failure_attempt'
        : `skipped:${result.reason}`,
  };
}

export function buildAttributionFollowupHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<AttributionFollowupJobData>[]) => Promise<void> {
  const runTaskFn = deps.runTaskFn ?? makePracticeTaskRunFn(db);
  const enqueueVariant = deps.enqueueVariantGen ?? defaultEnqueueVariantGen;
  return async (jobs) => {
    for (const job of jobs) {
      const attemptEventId = failureLearningAttemptId(job.data);
      if (!attemptEventId) {
        console.warn('[attribution_followup] job missing attempt_event_id', job.id);
        continue;
      }
      try {
        const result = await runAttributionFollowup({
          db,
          attemptEventId,
          runTaskFn,
          enqueueVariantGen: enqueueVariant,
        });
        console.log(`[attribution_followup] ${attemptEventId} → ${result.status}`);
      } catch (error) {
        console.error(`[attribution_followup] ${attemptEventId} failed`, error);
        throw error;
      }
    }
  };
}
