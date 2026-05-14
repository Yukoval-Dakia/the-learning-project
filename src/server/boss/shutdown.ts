import type { PgBoss } from 'pg-boss';

/**
 * Install SIGTERM / SIGINT handlers that gracefully stop pg-boss.
 *
 * Usage：worker entrypoint（`scripts/worker.ts`, Step 14）启动时调一次。
 *
 * graceful=true 让正在执行的 job 跑完（最长 30s），expire 之后才退出进程。
 * pg-boss 会在 stop 后释放连接池，所有 SQL listen 也会断开。
 */
export function installShutdownHandler(boss: PgBoss): void {
  let shuttingDown = false;
  const handler = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[boss] ${signal} received, stopping gracefully (timeout 30s)...`);
    try {
      await boss.stop({ graceful: true, timeout: 30_000 });
      console.log('[boss] stopped cleanly');
      process.exit(0);
    } catch (err) {
      console.error('[boss] error during shutdown', err);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void handler('SIGTERM'));
  process.on('SIGINT', () => void handler('SIGINT'));
}
