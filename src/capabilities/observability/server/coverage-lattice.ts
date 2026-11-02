// Read-only IO layer for the coverage lattice. Pure functions live in the core; this
// does DB reads with the real constants. It covers the scanner's four rules only:
// confusable_contrast comes from a different discovery source, so it is not joined.

import { and, asc, eq, gte } from 'drizzle-orm';
import {
  COVERAGE_DEPTH_THRESHOLD,
  NEAR_WINDOW,
  SUPPLY_DISPATCH_COOLDOWN_DAYS,
  assembleScanInput,
  scanCoverageGaps,
} from '@/capabilities/practice/public';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { getDefaultSubjectRegistry } from '@/subjects/profile';
import {
  type CoverageLatticeRead,
  type LatticeConstants,
  type SupplyActivityEvent,
  aggregateSupplyActivity,
  buildCoverageLattice,
} from './coverage-lattice-core';

export type {
  CoverageLatticeRead,
  GapActivity,
  KcCoverageRow,
  LatticeGap,
  SubjectCoverage,
} from './coverage-lattice-core';

const SUPPLY_EVENT_ACTION = 'experimental:question_supply';
const DAY_MS = 24 * 60 * 60 * 1000;
// At least the cooldown window. The composite index filters on action, then created_at
// inside the index; at this data scale that is fine.
const ACTIVITY_LOOKBACK_DAYS = Math.max(30, SUPPLY_DISPATCH_COOLDOWN_DAYS);

const LATTICE_CONSTANTS: LatticeConstants = {
  coverageDepthThreshold: COVERAGE_DEPTH_THRESHOLD,
  nearWindow: NEAR_WINDOW,
  cooldownDays: SUPPLY_DISPATCH_COOLDOWN_DAYS,
};

/** Read-only display names from the subject registry. */
function displayNameMap(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const p of getDefaultSubjectRegistry().listProfiles()) {
    out[p.id] = p.displayName;
  }
  return out;
}

/**
 * Load the lattice for the current scan window; read-only.
 */
export async function loadCoverageLattice(
  db: Db | Tx,
  now: Date = new Date(),
): Promise<CoverageLatticeRead> {
  const t0 = Date.now();
  const scanInput = await assembleScanInput(db);
  const scanMs = Date.now() - t0;
  const targets = scanCoverageGaps(scanInput);

  // One activity query over the lookback window; aggregate per fingerprint in memory.
  const cutoff = new Date(now.getTime() - ACTIVITY_LOOKBACK_DAYS * DAY_MS);
  const rows = await db
    .select({ payload: event.payload, created_at: event.created_at })
    .from(event)
    .where(and(eq(event.action, SUPPLY_EVENT_ACTION), gte(event.created_at, cutoff)))
    // Stable order makes latest/dispatched deterministic for equal timestamps.
    .orderBy(asc(event.created_at));

  const activityEvents: SupplyActivityEvent[] = [];
  for (const r of rows) {
    const p = r.payload as Record<string, unknown> | null;
    const fingerprint = p?.fingerprint;
    const status = p?.status;
    if (typeof fingerprint !== 'string' || typeof status !== 'string') continue;
    activityEvents.push({ fingerprint, status, createdAt: r.created_at });
  }
  const activityByFingerprint = aggregateSupplyActivity(
    activityEvents,
    now,
    SUPPLY_DISPATCH_COOLDOWN_DAYS,
  );

  return buildCoverageLattice(scanInput, targets, activityByFingerprint, LATTICE_CONSTANTS, {
    now,
    scanMs,
    displayNameById: displayNameMap(),
  });
}
