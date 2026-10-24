// Hub-sync job family. Every scheduled path converges through `runHubSyncCycle`;
// none applies a body directly. Durability comes from the topology trigger that
// marks a cursor dirty plus the every-minute recovery floor, so convergence is
// bounded by about a minute even if the immediate wake is lost. Abandoned
// edit-session presence is swept in the manifest pre-eligibility hook so
// dormancy skips coverage repair only.

import type { Job } from 'pg-boss';

import { getRunningNotesBoss } from '@/capabilities/notes/server/boss-port';
import {
  type HubSyncCycleResult,
  runHubSyncCycle,
} from '@/capabilities/notes/server/hub-sync-reconciliation';
import { recoverNoteHandoffsAndClaims } from '@/capabilities/notes/server/note-handoff';
import type { Db } from '@/db/client';

const RECOVERY_MAX_ARTIFACTS = 25;
const WAKE_MAX_ARTIFACTS = 25;
const NIGHTLY_MAX_ARTIFACTS = 25;

interface HubSyncSend {
  send: (
    queue: string,
    data: unknown,
    options?: { singletonKey?: string; singletonSeconds?: number },
  ) => Promise<unknown>;
}

export const HUB_SYNC_RECOVERY_QUEUE = 'hub_sync_recovery';
export const HUB_SYNC_RECOVERY_CONTINUATION_KEY = 'hub_sync_recovery_continuation';

type RecoveryFloorDeps = {
  runHubRecovery?: () => Promise<HubSyncCycleResult>;
  recoverHandoffsAndClaims?: () => Promise<void>;
};

// singletonKey alone does not de-duplicate on a standard pg-boss queue; it needs
// a singletonSeconds window. 30s is ample de-dup headroom for a backlog drain.
const HUB_SYNC_CONTINUATION_SINGLETON_SECONDS = 30;

// One repair key per Asia/Shanghai calendar day makes the sweep idempotent across
// retries.
export function nightlyRepairKey(now = new Date()): string {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return `nightly:${ymd}`;
}

// Enqueue one singleton continuation so a backlog drains without duplicate jobs.
async function dispatchContinuation(deps: HubSyncSend, result: HubSyncCycleResult): Promise<void> {
  if (result.continuation_needed) {
    await deps.send(
      HUB_SYNC_RECOVERY_QUEUE,
      {},
      {
        singletonKey: HUB_SYNC_RECOVERY_CONTINUATION_KEY,
        singletonSeconds: HUB_SYNC_CONTINUATION_SINGLETON_SECONDS,
      },
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

// Manifest handlers get only `db`, so they peek the already-running boss instead
// of starting one. Tests run without a boss, making this a no-op.
async function dispatchContinuationViaRunningBoss(result: HubSyncCycleResult): Promise<void> {
  if (!result.continuation_needed) return;
  const boss = getRunningNotesBoss();
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

// Nightly wrapper: a repair sweep, never a direct apply.
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

// Manifest-loaded factories: the loader passes only `db`, so the continuation
// goes through the running boss. The builders above are the explicit-injection
// versions for tests and direct callers.

export function buildHubAutoSyncNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    const result = await runHubAutoSyncNightly(db);
    console.log('[hub_auto_sync_nightly] repair cycle', result);
    await dispatchContinuationViaRunningBoss(result);
  };
}

export function buildHubSyncRecoveryJobHandler(
  db: Db,
  deps: RecoveryFloorDeps = {},
): (jobs: Job[]) => Promise<void> {
  return async () => {
    const errors: unknown[] = [];
    try {
      const result = await (deps.runHubRecovery?.() ??
        runHubSyncCycle(db, {
          reason: 'recovery',
          maxArtifacts: RECOVERY_MAX_ARTIFACTS,
        }));
      await dispatchContinuationViaRunningBoss(result);
    } catch (error) {
      errors.push(error);
    }
    try {
      await (deps.recoverHandoffsAndClaims?.() ?? recoverNoteHandoffsAndClaims(db));
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw errors[0];
  };
}

// A produced wake job drives one bounded cycle; the cron floor remains the
// backstop for lost wakes.
export function buildHubSyncMutationWakeJobHandler(db: Db): (jobs: Job[]) => Promise<void> {
  return async () => {
    const result = await runHubSyncCycle(db, {
      reason: 'mutation_wake',
      maxArtifacts: WAKE_MAX_ARTIFACTS,
    });
    await dispatchContinuationViaRunningBoss(result);
  };
}
