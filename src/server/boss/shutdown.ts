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
 * Gracefully stop pg-boss without owning the enclosing process exit.
 *
 * API and standalone worker share the drain and interrupted-work logging.
 *
 * graceful=true 让正在执行的 job 跑完（最长 30s），expire 之后才退出进程。
 * pg-boss 会在 stop 后释放连接池，所有 SQL listen 也会断开。
 *
 * YUK-241: 在 graceful stop 前后各拍一张 in-flight 快照 —— stop 返回后仍标记为
 * active 的 queue 说明 30s 超时强制中断了它们的 job（这些 job 是 durable 的，
 * 下次 worker 启动会重试或进 dead-letter），把它们的 queue 名 + 活跃数记进日志，
 * 方便事后排查「这次重启打断了哪些任务」。
 */
export async function stopBossGracefully(boss: PgBoss, reason: string): Promise<void> {
  const before = snapshotActiveQueues(boss);
  console.log(
    `[boss] ${reason} received, stopping gracefully (timeout 30s)...`,
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
  } catch (err) {
    // stop() can reject when the graceful timeout elapses with work still
    // running. Capture which queues were caught mid-job for the same trace.
    const interrupted = snapshotActiveQueues(boss);
    console.error('[boss] error during shutdown', err, {
      interrupted: interrupted.length > 0 ? interrupted : undefined,
    });
    throw err;
  }
}

export function installShutdownHandler(boss: PgBoss): void {
  let shuttingDown = false;
  const handler = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await stopBossGracefully(boss, signal);
      process.exit(0);
    } catch {
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

/**
 * YUK-980 — boot-window variant covering the FULL worker lifetime, installed BEFORE
 * registerCapabilityTools()/startBossWorker()（此前 SIGTERM 落在注册/启动窗口时进程
 * 按 Node 默认立即退出——可能正在装配、正在起 boss、正在消费首批 job，无 graceful）。
 *
 * 三个窗口，两种行为：
 * - 信号到达时 boss 尚未 start（装配/pre-consumption 窗口，getBoss() → null）→
 *   无 job 可 drain（handlers 未注册），直接 exit(1) 交容器重启策略，不假装 graceful；
 * - boss 已 start 但 startBossWorker 尚未返回（startup-tail 窗口：markBossStarted
 *   已执行、consumers 已在消费，registerCapabilityJobs→reconcile 仍在注册）→
 *   【有界】等待 startup promise 落定再 drain：drain 与注册并发会让后续 work()/send()
 *   撞上 stopping/stopped boss（work() 直接 throw 'Workers are disabled'），并与
 *   boot owner 的退出码赛跑。镜像 API 进程的先例（server/index.ts installApiShutdown
 *   await workerStartup），但 worker 独自持有 drain 预算，必须封顶；
 * - startup 已完成 → 与 installShutdownHandler 完全同款的 graceful stop。
 *
 * getStartup() 的 promise 无论是 resolve 还是 reject 都继续 drain（注册失败≠丢弃
 * in-flight job）；超时也继续 stop（残余注册步撞上 stopped boss 会 reject，由 boot
 * owner 吞掉——exit 只有一个 owner）。返回的 handle 让 boot owner 查询 ownsExit()，
 * 避免它的 startup-catch 在 shutdown 进行中抢 exit(1)。
 *
 * worker.ts 用它替换原「启动后才 install」的调用；installShutdownHandler(boss) 保留给
 * 既有测试与其他调用方，不重复注册。
 */
export type BootShutdownHandle = {
  /** True once a signal has been received — from then on this handler alone owns process.exit. */
  ownsExit: () => boolean;
};

// docker-compose worker stop_grace_period=40s；stopBossGracefully 已占 30s drain。
// startup-tail 等待不能再叠加独立的 30s。9s + 30s 留约 1s 收尾余量；
// pg-boss 连接池关闭仍可能延迟，39s 是等待预算而非整个进程的硬退出上界。
export const STARTUP_TAIL_WAIT_MS = 9_000;

type StartupTailOutcome =
  | { kind: 'settled' }
  | { kind: 'rejected'; err: unknown }
  | { kind: 'timeout' };

/**
 * Race the startup promise against a timer. On timeout the REAL promise stays
 * pending — its eventual rejection is already handled twice over (the rejection
 * branch here subscribes, and the boot owner awaits the same promise), so a
 * late failure can never surface as an unhandledRejection.
 */
function startupTailOutcome(startup: Promise<unknown>, ms: number): Promise<StartupTailOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<StartupTailOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), ms);
  });
  const settled = startup.then(
    () => ({ kind: 'settled' }) as StartupTailOutcome,
    (err: unknown) => ({ kind: 'rejected', err }) as StartupTailOutcome,
  );
  return Promise.race([settled, timedOut]).finally(() => clearTimeout(timer));
}

export function installBootShutdownHandler(
  getBoss: () => PgBoss | null,
  getStartup: () => Promise<unknown> | null = () => null,
  startupTailWaitMs: number = STARTUP_TAIL_WAIT_MS,
): BootShutdownHandle {
  let shuttingDown = false;
  const handler = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const boss = getBoss();
    if (boss === null) {
      console.warn(
        `[boss] ${signal} during boot window (registration/startup, no jobs drainable) — exiting for supervised restart`,
      );
      process.exit(1);
      return;
    }
    const startup = getStartup();
    if (startup) {
      console.log(
        `[boss] ${signal} while registration is still finishing — waiting up to ${startupTailWaitMs}ms for the startup tail before draining`,
      );
      const outcome = await startupTailOutcome(startup, startupTailWaitMs);
      if (outcome.kind === 'rejected') {
        console.warn(
          '[boss] startup failed while shutting down — continuing the graceful drain (restart is supervised)',
          outcome.err,
        );
      } else if (outcome.kind === 'timeout') {
        console.warn(
          `[boss] startup tail did not settle within ${startupTailWaitMs}ms — stopping anyway; late registration errors are expected and logged by the boot owner`,
        );
      }
    }
    try {
      await stopBossGracefully(boss, signal);
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  return { ownsExit: () => shuttingDown };
}
