import type { Job } from 'pg-boss';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { authorInterventionPackage } from '@/kernel/records/intervention-package-author';
import {
  PROVIDER_WAIT_MAX,
  planJobProviderWait,
  providerWaitDelayMs,
  providerWaitOutput,
} from '@/server/ai/provider-wait';
import { getRunningBoss } from '@/server/boss/client';
import { type JobYieldOutput, reportJobYield } from '@/server/boss/job-yield';
import { prepareInterventionWave } from '../server/intervention/prepare';
import {
  type InterventionPrepareRecoveryBoss,
  rearmInterventionPreparationWait,
} from '../server/intervention/reconcile';
import { failInterventionPreparation } from '../server/intervention/store';
import { prepareInterventionJobYield } from './prepare-intervention-yield';

const PrepareInterventionJobDataSchema = z
  .object({
    intervention_id: z.string().trim().min(1),
    version: z.number().int().positive(),
    idempotency_key: z.string().trim().min(1),
    provider_waits: z.number().int().nonnegative().optional(),
  })
  .strict();

export async function runPrepareInterventionJob(
  db: Db,
  raw: unknown,
  preparationJobId: string,
): Promise<ReturnType<typeof prepareInterventionWave>> {
  const data = PrepareInterventionJobDataSchema.parse(raw);
  return prepareInterventionWave(
    db,
    {
      interventionId: data.intervention_id,
      version: data.version,
      idempotencyKey: data.idempotency_key,
      preparationJobId,
    },
    { authorPackageFn: authorInterventionPackage },
  );
}

export function buildPrepareInterventionHandler(
  db: Db,
): (jobs: Job<unknown>[]) => Promise<JobYieldOutput> {
  return async (jobs) => {
    const job = jobs[0];
    if (!job) throw new Error('prepare_intervention handler received no job');
    try {
      const result = await runPrepareInterventionJob(db, job.data, job.id);
      console.log('[prepare_intervention] result', {
        status: result.status,
        intervention_id: result.intervention_id,
        version: result.version,
        ...(result.status === 'preparation_failed'
          ? { reason_code: result.reason_code.slice(0, 240) }
          : {}),
      });
      return reportJobYield('prepare_intervention', prepareInterventionJobYield(result));
    } catch (err) {
      // Proven transient provider rejection: schedule a delayed replacement
      // under the reconcile lock order instead of letting pg-boss burn retries
      // against a dead route. Unproven/billed/permanent failures still throw.
      const wait = await planJobProviderWait(db, err);
      if (!wait) throw err;
      const data = PrepareInterventionJobDataSchema.parse(job.data);
      const nextWaits = (data.provider_waits ?? 0) + 1;
      if (nextWaits > PROVIDER_WAIT_MAX) {
        const failed = await failInterventionPreparation(db, {
          interventionId: data.intervention_id,
          version: data.version,
          expectedPreparationJobId: job.id,
          failureCode: `provider_wait_exhausted:${wait.retryClass}`,
        });
        if (failed.status === 'preparation_failed') {
          return reportJobYield('prepare_intervention', {
            attempted: 1,
            succeeded: 0,
            failed: 1,
          });
        }
        // A recovery or terminal flip moved the aggregate under us.
        return reportJobYield('prepare_intervention', {
          attempted: 0,
          succeeded: 0,
          failed: 0,
        });
      }
      const boss = getRunningBoss();
      if (!boss) {
        throw new Error('prepare_intervention provider wait requires the running pg-boss');
      }
      const outcome = await rearmInterventionPreparationWait(
        db,
        boss as InterventionPrepareRecoveryBoss,
        {
          interventionId: data.intervention_id,
          version: data.version,
          idempotencyKey: data.idempotency_key,
          supersededJobId: job.id,
          waits: nextWaits,
          delayMs: providerWaitDelayMs(nextWaits),
        },
      );
      console.warn('[prepare_intervention] provider_waiting', {
        outcome,
        intervention_id: data.intervention_id,
        wait: `${nextWaits}/${PROVIDER_WAIT_MAX}`,
        retry_class: wait.retryClass,
      });
      return {
        ...reportJobYield('prepare_intervention', {
          attempted: 0,
          succeeded: 0,
          failed: 0,
        }),
        ...providerWaitOutput({
          retryClass: wait.retryClass,
          detail: `wait ${nextWaits}/${PROVIDER_WAIT_MAX} ${outcome}, evidence=${wait.evidenceRef}`,
        }),
      };
    }
  };
}
