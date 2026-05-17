import { PgBoss } from 'pg-boss';

// Singleton PgBoss instance —— pg-boss 内部维护连接池，每进程一个。
// 复用模式与 src/db/client.ts 的 db 单例一致。
//
// 配置说明（plan Step 2.3 写的 newJobCheckInterval / archiveCompletedAfterSeconds /
// expireInSeconds 在 pg-boss v12 已搬到 per-queue / per-work 级别）：
//   schema='pgboss'  —— 自动建出独立 schema，与业务表隔离
//
// 以下原本在 constructor 的选项，v12 在调 `boss.work(queue, opts, handler)` 或
// `boss.createQueue(name, opts)` 时设：
//   - retentionSeconds / deleteAfterSeconds（替换 archiveCompletedAfterSeconds）
//   - expireInSeconds（per-job timeout）
//   - newJobCheckIntervalSeconds（per-worker poll interval；测试用低值，生产用默认 2s）

let bossInstance: PgBoss | null = null;
let startPromise: Promise<PgBoss> | null = null;

export function createBoss(): PgBoss {
  if (bossInstance) return bossInstance;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to create PgBoss instance');
  }
  bossInstance = new PgBoss({
    connectionString,
    schema: 'pgboss',
  });
  return bossInstance;
}

/**
 * Lazily start the singleton pg-boss client and return it ready to use.
 *
 * Why this exists: pg-boss v12 requires `boss.start()` to be called before
 * `boss.send()` (otherwise it throws "Database not opened"). The worker
 * process calls start() at boot in scripts/worker.ts. App processes (Next
 * route handlers) need to enqueue without dragging pg-boss into the
 * instrumentation bundle — webpack can't trace pg's Node built-ins through
 * the instrumentation hook compile path. So routes call this at request time
 * the first time they need to send; the promise is cached so subsequent
 * calls are O(1).
 *
 * App processes only call boss.send/schedule via this getter — they never
 * call boss.work(), so jobs aren't pulled in this process even though
 * pg-boss is "started" here.
 */
export async function getStartedBoss(): Promise<PgBoss> {
  if (!startPromise) {
    const boss = createBoss();
    startPromise = boss.start().then(() => boss);
  }
  return startPromise;
}

/**
 * Reset the singleton —— **test-only**.
 *
 * Production code must never call this; the singleton's lifecycle is tied to
 * the process. Vitest tests need to recreate the instance across files when
 * DATABASE_URL points at a fresh testcontainer.
 */
export function _resetBossForTests(): void {
  bossInstance = null;
  startPromise = null;
}
