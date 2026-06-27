// YUK-445 (A11 — 谨慎 / 速度-精度轴) — nightly trigger for the EZ-diffusion axis descriptor.
//
// runAxisStateBatch (src/server/calibration/axis-writer.ts) folds scored RT-bearing attempts
// per primary KC and upserts the slow-varying (drift_v, boundary_a, ter) descriptor for every
// KC past the usage gate. This job is its sole live trigger — structurally a peer of
// kt_estimate_nightly / recalibration_nightly: a per-KC nightly scan that writes a descriptor
// column and feeds NO θ̂/p(L)/scheduling (display-only read-out via placement-profile). So it
// touches no LIVE estimation engine and needs no dark-ship flag.
//
// provenance='adaptive' (the only live response source today) → boundary_a + ter persisted,
// drift_v left NULL (confounded by adaptive item selection — A11 hard boundary). A non-adaptive
// probe-set would run a second batch with provenance='probe' to fill drift_v.
//
// cron 05:40 Asia/Shanghai: a clear slot after the data-prep chain (item_prior 04:20 /
// recalibration 04:50 / answer_class 05:00 / kt_estimate 05:10 / reference 05:20) and after
// compose 05:30 — A11 reads only durable attempt events, so it has no ordering dependency on
// the selection chain; the late slot just avoids same-minute contention. queue=llm: shares the
// established slow-batch DLQ/retry bucket (this batch is pure CPU + DB, no LLM call).

import type { Db } from '@/db/client';
import { runAxisStateBatch } from '@/server/calibration/axis-writer';
import type { Job } from 'pg-boss';

export function buildAxisStateNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const result = await runAxisStateBatch(db);
      console.log('[axis_state_nightly] result', result);
    } catch (err) {
      console.error('[axis_state_nightly] failed', err);
      throw err;
    }
  };
}
