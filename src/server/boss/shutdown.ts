import type { PgBoss } from 'pg-boss';
import { flushLaminarTracing } from '@/server/ai/laminar-tracing';
import { stopDurableWorker } from '@/server/durable/prune-worker';

const SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * In-memory, so this stays safe while the pool is closing. pg-boss does not expose
 * in-flight job ids, so the log is queue name plus active count.
 */
function snapshotActiveQueues(boss: PgBoss): { name: string; count: number }[] {
  try {
    return boss
      .getWipData()
      .filter((w) => w.count > 0 && (w.state === 'active' || w.state === 'stopping'))
      .map((w) => ({ name: w.name, count: w.count }));
  } catch (err) {
    // A logging failure must not abort the stop.
    console.error('[boss] failed to snapshot in-flight jobs', err);
    return [];
  }
}

/**
 * Drain without owning process.exit. The caller decides the exit code.
 * A queue still active after stop was cut by the timeout. The durable row retries or dead-letters on the next boot.
 */
export async function stopBossGracefully(boss: PgBoss, reason: string): Promise<void> {
  const before = snapshotActiveQueues(boss);
  console.log(
    `[boss] ${reason} received, stopping gracefully (timeout 30s)...`,
    before.length > 0 ? { inFlight: before } : '(no in-flight jobs)',
  );
  try {
    const durableStopMs = await stopDurableWorker();
    await boss.stop({ graceful: true, timeout: Math.max(1, SHUTDOWN_TIMEOUT_MS - durableStopMs) });
    // Still active after stop means the timeout cut the job.
    const interrupted = snapshotActiveQueues(boss);
    if (interrupted.length > 0) {
      console.warn(
        '[boss] graceful timeout reached — jobs interrupted (will retry/dead-letter on next boot):',
        { interrupted },
      );
    }
    console.log('[boss] stopped cleanly');
  } catch (err) {
    // The graceful timeout resolves stop() and then shutdown continues. This catch is any other rejection.
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
      await flushLaminarTracing();
      process.exit(0);
    } catch {
      await flushLaminarTracing();
      process.exit(1);
    }
  };
  // Register the async function itself. A void wrapper drops the promise, so a test
  // that captured the listener could not await the drain.
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}

/**
 * Installed before boot, so a signal during registration does not take Node's default exit.
 * No boss yet means nothing is drainable, so exit 1 and let the supervisor restart.
 * Boss started but boot not returned: wait a bounded tail, then drain. Draining while
 * registration still calls work() throws, and it would race the boot owner's exit code.
 * A rejected or timed-out startup still drains. ownsExit tells the boot catch not to steal exit 1.
 * installShutdownHandler stays for callers that already hold a boss.
 */
export type BootShutdownHandle = {
  /** True once a signal has been received — from then on this handler alone owns process.exit. */
  ownsExit: () => boolean;
};

// Compose gives the worker 40s. The drain already takes 30s, so the tail wait is 9s.
// 39s is a wait budget. Closing the pool can still run past it.
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
      await flushLaminarTracing();
      process.exit(0);
    } catch {
      await flushLaminarTracing();
      process.exit(1);
    }
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  return { ownsExit: () => shuttingDown };
}
