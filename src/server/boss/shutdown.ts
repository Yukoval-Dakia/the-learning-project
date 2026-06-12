import type { PgBoss } from 'pg-boss';

const SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Snapshot the queues that still have an in-flight job, for shutdown logging.
 *
 * YUK-241 [STB-7]: pg-boss's `getWipData()` returns one entry per in-process
 * worker (those NOT already 'stopped'), each carrying the queue `name`, the
 * worker `state`, and `count` = jobs the worker currently holds active. A worker
 * with state 'active' (or 'stopping' with count > 0) is mid-job. This is the
 * in-memory source of truth — no DB query — so it's safe to call even while the
 * boss is tearing down its connection pool.
 *
 * Note: pg-boss does not expose the per-job UUIDs of in-flight work through a
 * public API (findJobs requires a queue name + can't filter by 'active' state),
 * so we surface queue name + active count instead of raw job IDs. That's enough
 * to tell an operator *which* durable jobs were cut off by the 30s timeout and
 * will be retried (or dead-lettered) on the next worker boot.
 */
function snapshotActiveQueues(boss: PgBoss): { name: string; count: number }[] {
  try {
    return boss
      .getWipData()
      .filter((w) => w.count > 0 && (w.state === 'active' || w.state === 'stopping'))
      .map((w) => ({ name: w.name, count: w.count }));
  } catch (err) {
    // getWipData is in-memory and shouldn't throw, but never let a shutdown
    // observability helper abort the actual graceful stop.
    console.error('[boss] failed to snapshot in-flight jobs', err);
    return [];
  }
}

/**
 * Install SIGTERM / SIGINT handlers that gracefully stop pg-boss.
 *
 * Usage：worker entrypoint（`scripts/worker.ts`, Step 14）启动时调一次。
 *
 * graceful=true 让正在执行的 job 跑完（最长 30s），expire 之后才退出进程。
 * pg-boss 会在 stop 后释放连接池，所有 SQL listen 也会断开。
 *
 * YUK-241: 在 graceful stop 前后各拍一张 in-flight 快照 —— stop 返回后仍标记为
 * active 的 queue 说明 30s 超时强制中断了它们的 job（这些 job 是 durable 的，
 * 下次 worker 启动会重试或进 dead-letter），把它们的 queue 名 + 活跃数记进日志，
 * 方便事后排查「这次重启打断了哪些任务」。
 */
export function installShutdownHandler(boss: PgBoss): void {
  let shuttingDown = false;
  const handler = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const before = snapshotActiveQueues(boss);
    console.log(
      `[boss] ${signal} received, stopping gracefully (timeout 30s)...`,
      before.length > 0 ? { inFlight: before } : '(no in-flight jobs)',
    );
    try {
      await boss.stop({ graceful: true, timeout: SHUTDOWN_TIMEOUT_MS });
      // After a graceful stop resolves, any worker STILL active means the 30s
      // timeout fired and cut its job off mid-run. Log it loudly so the
      // interrupted work is traceable (it will be retried / dead-lettered on the
      // next boot via the durable pg-boss job row).
      const interrupted = snapshotActiveQueues(boss);
      if (interrupted.length > 0) {
        console.warn(
          '[boss] graceful timeout reached — jobs interrupted (will retry/dead-letter on next boot):',
          { interrupted },
        );
      }
      console.log('[boss] stopped cleanly');
      process.exit(0);
    } catch (err) {
      // stop() can reject when the graceful timeout elapses with work still
      // running. Capture which queues were caught mid-job for the same trace.
      const interrupted = snapshotActiveQueues(boss);
      console.error('[boss] error during shutdown', err, {
        interrupted: interrupted.length > 0 ? interrupted : undefined,
      });
      process.exit(1);
    }
  };
  // Register the async handler directly. Node's EventEmitter ignores the
  // returned promise (the handler owns its own try/catch + process.exit, so an
  // unhandled rejection is impossible), and registering the real handler — not a
  // `() => void handler(...)` wrapper that discards the promise — lets callers
  // that capture the listener (e.g. the YUK-241 unit test) await the full
  // graceful-stop chain deterministically instead of racing the discarded promise.
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}
