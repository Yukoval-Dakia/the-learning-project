import type { JobYield } from '@/server/boss/job-yield';

type PrepareInterventionYieldInput =
  | {
      status: 'active';
      intervention_id: string;
      version: number;
      idempotent: boolean;
      delivery_mode: 'shadow' | 'eligible';
    }
  | {
      status: 'preparation_failed';
      intervention_id: string;
      version: number;
      reason_code: string;
      idempotent: boolean;
    }
  | {
      status: 'skipped';
      intervention_id: string;
      version: number;
      terminal_status: string;
    };

export function prepareInterventionJobYield(result: PrepareInterventionYieldInput): JobYield {
  const isIdle =
    result.status === 'skipped' || ('idempotent' in result && result.idempotent === true);
  return {
    attempted: isIdle ? 0 : 1,
    succeeded: !isIdle && result.status === 'active' ? 1 : 0,
    failed: !isIdle && result.status === 'preparation_failed' ? 1 : 0,
  };
}
