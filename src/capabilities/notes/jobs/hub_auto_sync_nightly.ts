// YUK-384 — hub-sync job family. The nightly job is NO LONGER a direct auto-zone
// applier; it is one member of a family that all route through `runHubSyncCycle`:
//   - hub_sync_mutation_wake — best-effort immediate wake after a topology commit
//   - hub_sync_recovery       — every-minute recovery floor (drains ready cursors)
//   - hub_auto_sync_nightly   — 02:45 BJT coverage repair sweep
// The deterministic auto-zone compute (buildAutoZonePatch + resolveHubMeshAtomics)
// is RETAINED but now runs INSIDE the reconciler's fenced apply, never here — no
// scheduled path applies directly (ADR-0020 §9 preserved via the reconciler).
//
// Durability is the PostgreSQL topology trigger (records the dirty) + the
// minute-recovery floor (≤60s convergence). The immediate mutation wake is a
// pure latency optimization and best-effort.

import type { Job } from 'pg-boss';

import {
  type HubSyncCycleResult,
  runHubSyncCycle,
} from '@/capabilities/notes/server/hub-sync-reconciliation';
import type { Db } from '@/db/client';

const RECOVERY_MAX_ARTIFACTS = 25;
const WAKE_MAX_ARTIFACTS = 25;
const NIGHTLY_MAX_ARTIFACTS = 25;

export const HUB_SYNC_RECOVERY_QUEUE = 'hub_sync_recovery';
export const HUB_SYNC_MUTATION_WAKE_QUEUE = 'hub_sync_mutation_wake';
export const HUB_SYNC_RECOVERY_CONTINUATION_KEY = 'hub_sync_recovery_continuation';

// pg-boss `send` seam, injected so the handlers stay unit-testable and no topology
// writer is forced to import pg-boss.
export interface HubSyncSend {
  send: (queue: string, data: unknown, options?: { singletonKey?: string }) => Promise<unknown>;
}

// Asia/Shanghai calendar-date repair key `nightly:YYYY-MM-DD` (en-CA formats as
// YYYY-MM-DD). One key per BJT day makes the sweep idempotent across retries.
export function nightlyRepairKey(now = new Date()): string {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return `nightly:${ymd}`;
}

// When a bounded cycle leaves ready work, enqueue exactly ONE singleton-keyed
// continuation so a backlog drains fairly without piling up duplicate jobs.
async function dispatchContinuation(deps: HubSyncSend, result: HubSyncCycleResult): Promise<void> {
  if (result.continuation_needed) {
    await deps.send(
      HUB_SYNC_RECOVERY_QUEUE,
      {},
      { singletonKey: HUB_SYNC_RECOVERY_CONTINUATION_KEY },
    );
  }
}

export function buildHubSyncRecoveryHandler(db: Db, deps: HubSyncSend) {
  return async (): Promise<HubSyncCycleResult> => {
    const result = await runHubSyncCycle(db, {
      reason: 'recovery',
      maxArtifacts: RECOVERY_MAX_ARTIFACTS,
    });
    await dispatchContinuation(deps, result);
    return result;
  };
}

export function buildHubSyncMutationWakeHandler(db: Db, deps: HubSyncSend) {
  return async (): Promise<HubSyncCycleResult> => {
    const result = await runHubSyncCycle(db, {
      reason: 'mutation_wake',
      maxArtifacts: WAKE_MAX_ARTIFACTS,
    });
    await dispatchContinuation(deps, result);
    return result;
  };
}

export function buildHubSyncNightlyRepairHandler(db: Db, deps: HubSyncSend) {
  return async (): Promise<HubSyncCycleResult> => {
    const result = await runHubSyncCycle(db, {
      reason: 'nightly_repair',
      maxArtifacts: NIGHTLY_MAX_ARTIFACTS,
      repairKey: nightlyRepairKey(),
    });
    await dispatchContinuation(deps, result);
    return result;
  };
}

/**
 * Best-effort post-commit wake a topology writer MAY call after committing a
 * mutation. Swallows send failures — durability is the SQL trigger + minute
 * recovery, never this send.
 *
 * YUK-384 NOTE: no production topology writer calls this yet; immediacy currently
 * rests on the every-minute recovery floor (≤60s). Wiring writers to fire this is
 * a scoped follow-up.
 */
export async function sendHubSyncMutationWake(deps: HubSyncSend): Promise<void> {
  try {
    await deps.send(
      HUB_SYNC_MUTATION_WAKE_QUEUE,
      {},
      { singletonKey: HUB_SYNC_MUTATION_WAKE_QUEUE },
    );
  } catch {
    // best-effort; the minute-recovery floor still converges the durable dirty.
  }
}

// Thin nightly wrapper retained for existing callers: a repair sweep, never a
// direct apply. Returns the cycle result.
export async function runHubAutoSyncNightly(
  db: Db,
  opts: { now?: Date } = {},
): Promise<HubSyncCycleResult> {
  return runHubSyncCycle(db, {
    reason: 'nightly_repair',
    maxArtifacts: NIGHTLY_MAX_ARTIFACTS,
    repairKey: nightlyRepairKey(opts.now),
  });
}

// ── Manifest-loaded factories (JobHandlerFactory: (db) => (jobs) => Promise<void>) ──
// The manifest loader passes only `db` (no boss), so these converge via the cron
// floor and do NOT dispatch a boss continuation; the every-minute recovery cron
// picks up any remainder. The {send}-taking builders above are the full versions
// (used where a boss handle is available, e.g. handlers.ts).

export function buildHubAutoSyncNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    const result = await runHubAutoSyncNightly(db);
    console.log('[hub_auto_sync_nightly] repair cycle', result);
  };
}

export function buildHubSyncRecoveryJobHandler(db: Db): (jobs: Job[]) => Promise<void> {
  return async () => {
    const result = await runHubSyncCycle(db, {
      reason: 'recovery',
      maxArtifacts: RECOVERY_MAX_ARTIFACTS,
    });
    if (result.continuation_needed) {
      console.log('[hub_sync_recovery] continuation pending; next minute cron will resume');
    }
  };
}
