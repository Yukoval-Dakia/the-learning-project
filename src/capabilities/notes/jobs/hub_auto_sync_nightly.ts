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
import { getRunningBoss } from '@/server/boss/client';

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
 * Best-effort post-commit wake, given a send seam. Swallows send failures —
 * durability is the SQL trigger + minute recovery, never this send.
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

/**
 * Fire the immediate coalesced wake from a route/job HANDLER, AFTER the topology
 * mutation's outer transaction has committed. Peeks the ALREADY-running boss (no
 * start), so it is a pure no-op when boss is not running (tests, cold start) and
 * never becomes a boss-lifecycle driver. Errors are swallowed: this is a latency
 * optimization only — the durable trigger + minute-recovery floor converges any
 * missed/failed wake. Hub-agnostic + singleton-keyed (one send, not per-hub).
 */
export async function wakeHubSyncAfterCommit(): Promise<void> {
  const boss = getRunningBoss();
  if (!boss) return;
  try {
    await sendHubSyncMutationWake({
      send: (queue, data, options) => boss.send(queue, (data ?? {}) as object, options),
    });
  } catch (err) {
    console.warn('[hub_sync] mutation wake failed (best-effort; minute recovery converges)', err);
  }
}

// Dispatch the single continuation via the running boss (peek, no start), used
// by the manifest-registered handlers so a backlog drains within one cron tick
// in production. No-op when boss is not running (tests).
async function dispatchContinuationViaRunningBoss(result: HubSyncCycleResult): Promise<void> {
  if (!result.continuation_needed) return;
  const boss = getRunningBoss();
  if (!boss) return;
  try {
    await dispatchContinuation(
      { send: (queue, data, options) => boss.send(queue, (data ?? {}) as object, options) },
      result,
    );
  } catch (err) {
    console.warn('[hub_sync] continuation dispatch failed (best-effort)', err);
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
// The manifest loader passes only `db`, so these obtain the send handle by peeking
// the ALREADY-running boss (getRunningBoss, no start) and dispatch exactly one
// singleton-keyed continuation when the bounded cycle leaves a backlog — draining
// it within one cron tick instead of one hub-batch per minute. The {send}-taking
// builders above are the explicit-injection versions (tests / direct callers).

export function buildHubAutoSyncNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    const result = await runHubAutoSyncNightly(db);
    console.log('[hub_auto_sync_nightly] repair cycle', result);
    await dispatchContinuationViaRunningBoss(result);
  };
}

export function buildHubSyncRecoveryJobHandler(db: Db): (jobs: Job[]) => Promise<void> {
  return async () => {
    const result = await runHubSyncCycle(db, {
      reason: 'recovery',
      maxArtifacts: RECOVERY_MAX_ARTIFACTS,
    });
    await dispatchContinuationViaRunningBoss(result);
  };
}

// Consumer for the hub_sync_mutation_wake queue: a produced wake job drives one
// bounded cycle so the immediate wake actually converges (not just the cron).
export function buildHubSyncMutationWakeJobHandler(db: Db): (jobs: Job[]) => Promise<void> {
  return async () => {
    const result = await runHubSyncCycle(db, {
      reason: 'mutation_wake',
      maxArtifacts: WAKE_MAX_ARTIFACTS,
    });
    await dispatchContinuationViaRunningBoss(result);
  };
}
