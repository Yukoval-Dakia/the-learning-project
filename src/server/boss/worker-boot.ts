// Owns standalone-worker boot. scripts/worker.ts keeps env loading and the process-level handlers.
// Shutdown is installed first. Tools register before any boss or database assembly, and a
// manifest error fails the process instead of failing a job after it is consumed.
// The database client and start-worker are imported after loadEnv, because the client
// reads DATABASE_URL at module scope. The two log lines are part of the container contract.
// getRunningBoss() is the process singleton. A local variable would stay null until
// startBossWorker returned, and a signal in that tail would exit 1 while jobs were already running.

import { capabilities } from '@/capabilities';
import { registerCapabilityTools } from '@/server/ai/tools/register-capability-tools';
import { getRunningBoss } from '@/server/boss/client';
import { installBootShutdownHandler } from '@/server/boss/shutdown';

export type BootWorkerOptions = {
  /** Test-only: shrink the shutdown handler's bounded startup-tail wait (default 9s). */
  startupTailWaitMs?: number;
};

export async function bootWorker(options: BootWorkerOptions = {}): Promise<void> {
  let startup: Promise<unknown> | null = null;
  const shutdown = installBootShutdownHandler(
    () => getRunningBoss(),
    () => startup,
    options.startupTailWaitMs,
  );

  // This process does not go through server/index.ts, so it loads the tool inventory itself.
  await registerCapabilityTools(capabilities);
  console.log('[worker] capability tools registered');

  // After loadEnv. Importing the client earlier throws when DATABASE_URL is still unset.
  const [{ db }, { startBossWorker }] = await Promise.all([
    import('@/db/client'),
    import('@/server/boss/start-worker'),
  ]);
  try {
    // Stored before startBossWorker marks the boss started, so getStartup() is set
    // before the boss is visible.
    startup = startBossWorker(db);
    await startup;
    // A later signal should drain directly, not wait on a boot that already finished.
    startup = null;
  } catch (err) {
    // Once a signal is in progress, the shutdown handler owns the exit code.
    // A rejection here is the registration hitting a boss that is already stopping.
    if (shutdown.ownsExit()) {
      console.error(
        '[worker] startup failed during shutdown — exit owned by the shutdown handler',
        err,
      );
      return;
    }
    throw err;
  }
  console.log('[worker] running, handlers registered');
}
