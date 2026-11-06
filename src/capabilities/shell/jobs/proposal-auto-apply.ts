// pg-boss entry for the generic proposal auto-apply lane. One bounded sweep per
// minute: accept newly written strength-A proposals through the decision protocol,
// write the generic apply anchor, and leave anything the breaker or a domain
// failure refuses in the inbox for human review.

import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import { runProposalAutoApplySweep } from '@/kernel/proposals/auto-apply';

export function buildProposalAutoApplyHandler(db: Db) {
  return async (_jobs: Job[]) => {
    const result = await runProposalAutoApplySweep(db);
    if (result.outcome !== 'idle') {
      console.info('[proposal-auto-apply]', {
        outcome: result.outcome,
        applied: result.applied,
        skipped: result.skipped,
        backfilled: result.backfilled,
        breaker: result.breaker.level,
        breaker_applied: result.breaker.applied,
        breaker_cap: result.breaker.cap,
      });
    }
  };
}
