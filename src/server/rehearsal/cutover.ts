// Measured cutover window and the two failure records.
// A forgotten writer holds ACCESS EXCLUSIVE until its backend is terminated.
// The cutover side uses a short lock_timeout so the wait is evidence, not a hang.
// preparing and ready fence the current runtime. Older code is safe only if its writers are stopped.

import { sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import postgres from 'postgres';
import type { Db } from '@/db/client';
import { ContractEpochFenceError, assertContractEpochRunnable } from '@/server/contract-epoch';
import { fenceAwareJobHandler } from '@/server/contract-epoch/boss-fence';

export interface CutoverStep {
  name: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  detail?: Record<string, unknown>;
}

export interface ActivitySample {
  label: string;
  at: string;
  wal_lsn: string | null;
  /** State counts and the longest running query. */
  backends: { total: number; active: number; blocked: number; longest_active_ms: number | null };
}

/** WAL LSN and pg_stat_activity. The cutover window is measured from these. */
export async function observeWalAndActivity(db: Db, label: string): Promise<ActivitySample> {
  const lsnRows = await db.execute<{ lsn: string | null }>(
    sql`select pg_current_wal_lsn()::text as lsn`,
  );
  const actRows = await db.execute<{
    total: number;
    active: number;
    blocked: number;
    longest_active_ms: number | null;
  }>(sql`
    select
      count(*)::int as total,
      count(*) filter (where state = 'active')::int as active,
      count(*) filter (where wait_event_type is not null)::int as blocked,
      max(extract(epoch from (now() - query_start)) * 1000)::int as longest_active_ms
    from pg_stat_activity
    where datname = current_database() and pid <> pg_backend_pid()
  `);
  const act = actRows[0];
  return {
    label,
    at: new Date().toISOString(),
    wal_lsn: lsnRows[0]?.lsn ?? null,
    backends: {
      total: act?.total ?? 0,
      active: act?.active ?? 0,
      blocked: act?.blocked ?? 0,
      longest_active_ms: act?.longest_active_ms ?? null,
    },
  };
}

export function walDeltaBytes(start: string | null, end: string | null): number | null {
  if (start === null || end === null) return null;
  const parse = (lsn: string) => {
    const m = /^([0-9A-Fa-f]+)\/([0-9A-Fa-f]+)$/.exec(lsn);
    if (!m?.[1] || !m[2]) return null;
    return parseInt(m[1], 16) * 0x100000000 + parseInt(m[2], 16);
  };
  const a = parse(start);
  const b = parse(end);
  return a === null || b === null || b < a ? null : b - a;
}

/** Wall clock plus WAL and activity before and after each step. */
export class CutoverClock {
  private readonly steps: CutoverStep[] = [];
  private readonly samples: ActivitySample[] = [];
  private readonly db: Db;
  private startedAt = Date.now();

  constructor(db: Db) {
    this.db = db;
  }

  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const before = await observeWalAndActivity(this.db, `${name}:before`);
    this.samples.push(before);
    const started = Date.now();
    const result = await fn();
    const after = await observeWalAndActivity(this.db, `${name}:after`);
    this.samples.push(after);
    this.steps.push({
      name,
      started_at: new Date(started).toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      detail: {
        wal_bytes: walDeltaBytes(before.wal_lsn, after.wal_lsn),
        backends_before: before.backends.total,
        backends_after: after.backends.total,
      },
    });
    return result;
  }

  report(): {
    window_started_at: string;
    window_total_ms: number;
    steps: CutoverStep[];
    samples: ActivitySample[];
    wal_bytes_total: number | null;
  } {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    return {
      window_started_at: new Date(this.startedAt).toISOString(),
      window_total_ms: Date.now() - this.startedAt,
      steps: this.steps,
      samples: this.samples,
      wal_bytes_total: walDeltaBytes(first?.wal_lsn ?? null, last?.wal_lsn ?? null),
    };
  }
}

export interface StaleWriterLockResult {
  /** Exclusive lock refused while the stale writer held it. */
  lock_wait_observed: boolean;
  lock_wait_ms: number;
  lock_timeout_error: string | null;
  /** Same lock acquired right after that backend was terminated. */
  recovered_after_terminate: boolean;
  terminated_pid: number | null;
}

/**
 * A forgotten writer holds ACCESS EXCLUSIVE on the rehearsal database only.
 * The cutover connection's lock_timeout is the wait evidence.
 * terminate, then the same lock succeeds.
 */
export async function simulateStaleWriterLock(
  targetUrl: string,
  db: Db,
  table = 'assessment_submission',
): Promise<StaleWriterLockResult> {
  // Dedicated connection. The pool must not reuse the lock holder.
  const stale = postgres(targetUrl, { max: 1 });
  let stalePid: number | null = null;
  try {
    const pidRows = await stale`select pg_backend_pid() as pid`;
    stalePid = Number(pidRows[0]?.pid ?? 0) || null;
    // begin() never resolves while the lock is held. Do not await it.
    // Terminating the backend rejects the promise. That rejection is the expected path.
    const staleTx = stale
      .begin(async (tx) => {
        await tx.unsafe(`lock table "${table}" in access exclusive mode`);
        // Stay open until the outer terminate.
        await new Promise(() => {});
      })
      .catch(() => undefined);
    void staleTx;

    // Wait until the lock is visible on the stale backend.
    for (let i = 0; i < 50; i++) {
      const rows = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from pg_locks l
        join pg_stat_activity a on a.pid = l.pid
        where l.relation = ${table}::regclass and a.pid = ${stalePid ?? -1}
      `);
      if ((rows[0]?.n ?? 0) > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // Short lock_timeout. The timeout is the evidence.
    const contender = postgres(targetUrl, { max: 1 });
    let waitMs = 0;
    let timeoutError: string | null = null;
    const t0 = Date.now();
    try {
      await contender.begin(async (tx) => {
        await tx.unsafe(`set local lock_timeout = '250ms'`);
        await tx.unsafe(`lock table "${table}" in access exclusive mode`);
      });
    } catch (err) {
      waitMs = Date.now() - t0;
      timeoutError = err instanceof Error ? err.message : String(err);
    }
    // Production counterpart: stop the old writer and evict its connection.
    if (stalePid !== null) {
      await db.execute(sql`select pg_terminate_backend(${stalePid})`);
    }
    let recovered = false;
    try {
      await contender.begin(async (tx) => {
        await tx.unsafe(`set local lock_timeout = '2000ms'`);
        await tx.unsafe(`lock table "${table}" in access exclusive mode`);
      });
      recovered = true;
    } catch {
      recovered = false;
    }
    await contender.end({ timeout: 5 });
    return {
      lock_wait_observed: timeoutError !== null,
      lock_wait_ms: waitMs,
      lock_timeout_error: timeoutError,
      recovered_after_terminate: recovered,
      terminated_pid: stalePid,
    };
  } finally {
    await stale.end({ timeout: 5 }).catch(() => undefined);
  }
}

export interface FenceProbeResult {
  api_gate_rejected: boolean;
  job_delivery_fenced: boolean;
  detail: string;
}

/**
 * Whether the current epoch fences the API gate and one job delivery.
 * preparing and ready must both reject. This probe does not cover older binaries.
 */
export async function probeEpochFence(db: Db): Promise<FenceProbeResult> {
  let apiRejected = false;
  try {
    await assertContractEpochRunnable(db, 'rehearsal-api');
  } catch (err) {
    apiRejected = err instanceof ContractEpochFenceError;
  }
  let jobFenced = false;
  const handler = fenceAwareJobHandler(db, 'judge_run', async () => 'consumed');
  try {
    // Synthetic job, no created_on. preparing rejects as maintenance before the
    // birth-epoch branch, so no pgboss.job row is required.
    await handler([{ id: 'probe-job-1' } as Job]);
  } catch (err) {
    jobFenced = err instanceof ContractEpochFenceError;
  }
  return {
    api_gate_rejected: apiRejected,
    job_delivery_fenced: jobFenced,
    detail: `api=${apiRejected ? 'fenced' : 'runnable'} job=${jobFenced ? 'fenced' : 'delivered'}`,
  };
}
