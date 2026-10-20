/** Agency-owned port to the central AI execution and failure-observability service. */
import type { Db } from '@/db/client';
import { writeRetryableAiFailureLedger } from '@/server/ai/failure-ledger';
import { type TaskTextRunFn, costUsdToMicroUsd } from '@/server/ai/provenance';
import { type BoundRunTaskFn, type RunTaskCallCtx, makeRunTaskFn } from '@/server/ai/runner-fn';

export {
  type BoundRunTaskFn,
  type RunTaskCallCtx,
  type TaskTextRunFn,
  costUsdToMicroUsd,
  makeRunTaskFn,
  writeRetryableAiFailureLedger,
};

/**
 * YUK-1570 — owns the repeated `deps.runTaskFn ?? makeRunTaskFn(db)` default
 * resolution: an injected override wins verbatim, otherwise the db-bound text
 * runner is minted here (identical `makeRunTaskFn(db)` call — no baseCtx). The
 * db-binding knowledge lives behind this port; consumers pass their override
 * through without importing runner-fn themselves.
 */
export function agencyBoundTextRunner(db: Db, override?: TaskTextRunFn): TaskTextRunFn {
  return override ?? makeRunTaskFn(db);
}
