// YUK-470 (orphan-sweep leg) — abandon placement probe sessions left in 'started'
// for >6h. Mirrors prune_orphan_review_sessions (ADR-0013); the placement state
// machine has no 'paused' state (PlacementStatus = started|completed|abandoned),
// so the sweep scans 'started' only.
//
// The /placement/[id]/end sendBeacon close handles normal exits; this cron catches
// the same orphan cases as the review sweep (browser hard-kill, dropped beacon,
// dev hot-reload). Dark-ship today (PLACEMENT_PROBE_ENABLED=false → no probe is
// ever created, so the sweep finds nothing); this lands the go-live prerequisite
// ahead of the flag flip (YUK-470 acceptance — the last hardening leg).
//
// Selection: type='placement' AND status='started' AND started_at < now() - 6h.
// Action: abandon via Placement.abandonPlacementSession (single-owner transition).

import type { Db } from '@/db/client';
import { learning_session } from '@/db/schema';
import { Placement } from '@/server/session';
import { and, eq, lt } from 'drizzle-orm';
import type { Job } from 'pg-boss';

const ORPHAN_AGE_MS = 6 * 60 * 60 * 1000;

export async function runPruneOrphanPlacementSessions(db: Db): Promise<{ abandoned: number }> {
  const cutoff = new Date(Date.now() - ORPHAN_AGE_MS);
  const rows = await db
    .select({ id: learning_session.id })
    .from(learning_session)
    .where(
      and(
        eq(learning_session.type, 'placement'),
        eq(learning_session.status, 'started'),
        lt(learning_session.started_at, cutoff),
      ),
    );

  let abandoned = 0;
  for (const r of rows) {
    try {
      await Placement.abandonPlacementSession(db, r.id);
      abandoned += 1;
    } catch (err) {
      // Lost-race: another caller (the /end route) abandoned/completed it between
      // our SELECT and abandon. Skip — terminal states are fine.
      console.warn(`[prune_orphan_placement_sessions] skip ${r.id}:`, (err as Error).message);
    }
  }
  return { abandoned };
}

export function buildPruneOrphanPlacementSessionsHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    const result = await runPruneOrphanPlacementSessions(db);
    console.log('[prune_orphan_placement_sessions] result', result);
  };
}
