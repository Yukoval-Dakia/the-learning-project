import { describe, expect, it } from 'vitest';
import { prepareInterventionJobYield } from './prepare-intervention-yield';

describe('prepareInterventionJobYield', () => {
  it('reports terminal replay as idle because no failure-prone step ran', () => {
    expect(
      prepareInterventionJobYield({
        status: 'preparation_failed',
        intervention_id: 'int_a',
        version: 1,
        reason_code: 'already_failed',
        idempotent: true,
      }),
    ).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
  });

  it('reports a newly active or newly failed wave as one resolved attempt', () => {
    expect(
      prepareInterventionJobYield({
        status: 'active',
        intervention_id: 'int_a',
        version: 1,
        idempotent: false,
        delivery_mode: 'shadow',
      }),
    ).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(
      prepareInterventionJobYield({
        status: 'preparation_failed',
        intervention_id: 'int_a',
        version: 1,
        reason_code: 'package_quality',
        idempotent: false,
      }),
    ).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
  });
});
