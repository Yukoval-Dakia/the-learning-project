import { authorInterventionPackage } from '@/capabilities/practice/public';
import type { Db } from '@/db/client';
import { type JobYieldOutput, reportJobYield } from '@/server/boss/job-yield';
import type { Job } from 'pg-boss';
import { z } from 'zod';
import { prepareInterventionWave } from '../server/intervention/prepare';

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
): Promise<ReturnType<typeof prepareInterventionWave>> {
  const data = PrepareInterventionJobDataSchema.parse(raw);
  return prepareInterventionWave(
    db,
    {
      interventionId: data.intervention_id,
      version: data.version,
      idempotencyKey: data.idempotency_key,
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
    const result = await runPrepareInterventionJob(db, job.data);
    console.log('[prepare_intervention] result', result);
    const attempted = result.status === 'skipped' ? 0 : 1;
    return reportJobYield('prepare_intervention', {
      attempted,
      succeeded: result.status === 'active' ? 1 : 0,
      failed: result.status === 'preparation_failed' ? 1 : 0,
    });
  };
}
