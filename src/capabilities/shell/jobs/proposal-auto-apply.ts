// pg-boss entry for the generic proposal auto-apply lane. One bounded sweep per
// minute: accept newly written strength-A proposals through the decision protocol,
// write the generic apply anchor, and leave anything the breaker or a domain
// failure refuses in the inbox for human review.

import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import { runProposalAutoApplySweep } from '@/kernel/proposals/auto-apply';

export function buildProposalAutoApplyHandler(db: Db) {
  return async (_jobs: Job[]) => {
    // A missing accept port is a wiring defect; runProposalAutoApplySweep throws
    // HostOperationNotInstalledError and this handler deliberately lets it reach
    // pg-boss as a failed job instead of swallowing it.
    const result = await runProposalAutoApplySweep(db);
    // disabled returns before reading anything (breaker null); stay quiet so the
    // minute job does not log the off state every run.
    if (result.outcome !== 'idle' && result.breaker !== null) {
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
