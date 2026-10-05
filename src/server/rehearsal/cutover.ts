// ====================================================================
// YUK-1057 — cutover measured window + 失败处置观测
// ====================================================================
//
// 「切换演练产出 measured window + failure-handling record」（Q21 并入项）：
//
//   CutoverClock        —— begin_prepare → … → activate 的分步计时器
//                          （每步进入/退出时刻 + duration；artifact 落盘给
//                          真实切换填模板）。
//   observeWalAndActivity(db, label) —— pg_current_wal_lsn + pg_stat_activity
//                          快照（每步前后各一拍 → WAL 位移 + 活跃连接画像）。
//   simulateStaleWriterLock —— 故障注入：专用连接持 ACCESS EXCLUSIVE（模拟
//                          忘记停的旧 writer），cutover 侧排他锁等待 →
//                          lock_timeout 证据（失败处置 A）；pg_terminate_backend
//                          杀掉 → 锁等待解除（失败处置 B）。
//   probeEpochFence       —— epoch='preparing'/'ready' 下 gateContractEpoch /
//                          fenceAwareJobHandler 的拒绝证据（新码 runtime 全
//                          fenced；旧码靠停 writer —— 故障注入证明其前提）。

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
  /** 活跃 backend 画像（state 计数 + 最长运行 query）。 */
  backends: { total: number; active: number; blocked: number; longest_active_ms: number | null };
}

/** 采样 WAL LSN + pg_stat_activity（切窗观测原语）。 */
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

/** 分步计时器：每步 before/after 观测 WAL+activity，记录墙钟。 */
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
  /** 排他锁在 stale writer 持有期间被拒的证据。 */
  lock_wait_observed: boolean;
  lock_wait_ms: number;
  lock_timeout_error: string | null;
  /** 杀掉 stale backend 后同锁立即获得的证据。 */
  recovered_after_terminate: boolean;
  terminated_pid: number | null;
}

/**
 * 故障注入：stale writer 持有 ACCESS EXCLUSIVE（演练只在 rehearsal 库上 ——
 * 生产 cutover 的对应物是「旧 writer 忘停 / 连接未释放」）。
 * 观测链：cutover 连接 SET lock_timeout 尝试同锁 → 超时证据；
 * pg_terminate_backend → 重试成功。
 */
export async function simulateStaleWriterLock(
  targetUrl: string,
  db: Db,
  table = 'assessment_submission',
): Promise<StaleWriterLockResult> {
  // 专用连接 = stale writer（不被池化复用，持有期间独占）。
  const stale = postgres(targetUrl, { max: 1 });
  let stalePid: number | null = null;
  try {
    const pidRows = await stale`select pg_backend_pid() as pid`;
    stalePid = Number(pidRows[0]?.pid ?? 0) || null;
    // stale writer 持表锁（事务内持有直到 terminate —— 模拟忘停 writer）。
    // begin() 永不 resolve（回调内挂起）—— 不能 await；终止后端时的
    // reject 由 .catch 吞掉（预期路径）。
    const staleTx = stale
      .begin(async (tx) => {
        await tx.unsafe(`lock table "${table}" in access exclusive mode`);
        // 事务保持打开直到外层 terminate —— 不在此 await 内做别的。
        await new Promise(() => {});
      })
      .catch(() => undefined);
    void staleTx;

    // 等待锁真正建立（stale backend 可见且持锁）。
    for (let i = 0; i < 50; i++) {
      const rows = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from pg_locks l
        join pg_stat_activity a on a.pid = l.pid
        where l.relation = ${table}::regclass and a.pid = ${stalePid ?? -1}
      `);
      if ((rows[0]?.n ?? 0) > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // cutover 侧排他锁尝试 —— 短 lock_timeout 取证（不等无限挂起）。
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
    // 杀掉 stale backend（生产对应物：停旧 writer / 连接驱逐）。
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
 * fence 证据：在当前 DB epoch 状态下，runtime 裁决（assertContractEpochRunnable）
 * 与 per-delivery fence 是否拒绝。
 * 'preparing'/'ready' 下两者都应拒绝（maintenance）。
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
    // 合成 job：id/queue 可缺省 created_on 时按保守放行 —— 'preparing' 下
    // 是 maintenance 拒绝（未到 birth-epoch 分支），不依赖 pgboss.job 行。
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
