import { authorInterventionPackage } from '@/capabilities/practice/public';
import type { Db } from '@/db/client';
import { type JobYieldOutput, reportJobYield } from '@/server/boss/job-yield';
import type { Job } from 'pg-boss';
import { z } from 'zod';
import { prepareInterventionWave } from '../server/intervention/prepare';
import { prepareInterventionJobYield } from './prepare-intervention-yield';

const PrepareInterventionJobDataSchema = z
  .object({
    intervention_id: z.string().trim().min(1),
    version: z.number().int().positive(),
    idempotency_key: z.string().trim().min(1),
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
  };
}
