// YUK-1557 / ADR-0075 C6-2 — daily zero-AI harness scoreboard projection.
// The job only reads raw tables; failure to compute is visible as a failed job
// and never blocks any learner-facing work.

import type { Db } from '@/db/client';
import { runHarnessScoreboardDaily } from '../server/harness-scoreboard';

export function buildHarnessScoreboardDailyHandler(db: Db) {
  return async (): Promise<void> => {
    const { eventId, scoreboard } = await runHarnessScoreboardDaily(db);
    console.log(
      '[harness_scoreboard_daily] wrote %s for %s..%s',
      eventId,
      scoreboard.window.from_day,
      scoreboard.window.to_day,
    );
  };
}
