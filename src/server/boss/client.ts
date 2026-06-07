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

// Postgres unique-violation SQLSTATE. pg-boss talks to Postgres via
// node-postgres (`pg.Pool`, pg-boss/dist/db.js), so a duplicate-key surfaces as
// a raw `pg` error with `.code === '23505'` directly on the thrown object.
const PG_UNIQUE_VIOLATION = '23505';

/**
 * True when `err` is a benign pg-boss queue create race — a Postgres 23505
 * unique_violation on the queue primary key (`queue_pkey`, the only unique
 * constraint on `pgboss.queue`).
 *
 * YUK-259: when the app's in-process boss (instrumentation / getStartedBoss) and
 * the worker register/start against the same DB at once, pg-boss's `create_queue`
 * INSERT can race past its own `ON CONFLICT DO NOTHING` and raise
 * `Key (name)=(<queue>) already exists`. This includes pg-boss's INTERNAL
 * `__pgboss__send-it` queue created by the timekeeper at start, whose failure
 * surfaces on the boss `error` event (not through our createOrUpdateQueue). A
 * 23505 here means the queue already exists — the desired end state — so callers
 * treat it as benign. `constraint` may be absent on wrapped/older errors; any
 * 23505 reaching a queue-create path means the row already exists, so be lenient.
 */
export function isQueueCreateRace(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown; cause?: { code?: unknown } };
  const code = e.code ?? e.cause?.code;
  if (code !== PG_UNIQUE_VIOLATION) return false;
  return e.constraint === undefined || e.constraint === 'queue_pkey';
}

let bossInstance: PgBoss | null = null;
let startPromise: Promise<PgBoss> | null = null;

export function createBoss(): PgBoss {
  if (bossInstance) return bossInstance;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to create PgBoss instance');
  }
  // Under vitest, cap the internal connection pool aggressively. Multiple test
  // files re-create the singleton via _resetBossForTests; pg-boss's default
  // pool (~10) + testcontainer Postgres's default `max_connections=100` leave
  // little headroom once the dozens of test files have each cycled through a
  // boss instance. Capping at 2 inside vitest keeps the total well below the
  // ceiling and removes the "too many clients already" flake seen in
  // boss/client.test when run with the full suite. Production (worker /
  // route processes) keeps the library default.
  const isVitest = !!process.env.VITEST;
  bossInstance = new PgBoss({
    connectionString,
    schema: 'pgboss',
    ...(isVitest ? { max: 2 } : {}),
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
    startPromise = boss
      .start()
      .then(() => boss)
      .catch((err) => {
        // YUK-259: pg-boss's own `boss.start()` directly awaits the timekeeper
        // creating its internal `__pgboss__send-it` queue (pg-boss index.js
        // start → timekeeper.start → manager.createQueue, an `INSERT ... ON
        // CONFLICT DO NOTHING` that can still race-raise 23505 `queue_pkey`).
        // During a cold start where this app process and the worker race to
        // start against the same DB, that benign race rejects the start()
        // promise — and because we cache it, every later getStartedBoss() caller
        // would re-reject (a request-time 500) until the process restarts. A
        // 23505 here means SEND_IT already exists and the db is already opened
        // (pg-boss opens it before the timekeeper runs), so `send()`/`schedule()`
        // work; swallow it and resolve to the usable boss. Any other failure is a
        // real start error: re-throw it, but clear the cached promise first so a
        // later call can retry instead of being permanently poisoned.
        if (isQueueCreateRace(err)) {
          console.warn(
            '[boss] getStartedBoss(): boss.start() hit pg-boss internal SEND_IT queue create race (23505 queue_pkey) — benign, queue already exists, continuing (YUK-259)',
          );
          return boss;
        }
        startPromise = null;
        throw err;
      });
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
