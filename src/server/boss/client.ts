import { PgBoss } from 'pg-boss';

import { getServerEnv, resolveBossAutomationMode } from '@/server/env';

// Callers that own a queue import the singleton and the transaction adapter from here.
export { fromPgBossDrizzleTx } from '@/db/pg-boss-drizzle';

// One PgBoss per process. It owns its pool. v12 sets retention, expiry, and the
// poll interval on createQueue or work, not on this constructor. schema 'pgboss'
// keeps those tables off the business schema.

// pg-boss uses node-postgres, so a duplicate key is a raw error with this code.
const PG_UNIQUE_VIOLATION = '23505';

/**
 * True when a queue-create 23505 means the row already exists.
 * A wrapped error may omit `constraint`. The internal send queue's create rejects start().
 */
export function isQueueCreateRace(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown; cause?: { code?: unknown } };
  const code = e.code ?? e.cause?.code;
  if (code !== PG_UNIQUE_VIOLATION) return false;
  return e.constraint === undefined || e.constraint === 'queue_pkey';
}

// Dev re-evaluates this module and would drop the only handle on the pool.
// Cache the state on globalThis outside production so a reload can still stop it.
// Production has no reload, so the module cache is enough.
// `started` is the peek handle. It is set when start resolves, when that 23505 is
// swallowed, or when the worker calls markBossStarted. getRunningBoss peeks it
// and must not start a boss on its own.
type BossState = {
  instance: PgBoss | null;
  startPromise: Promise<PgBoss> | null;
  started: PgBoss | null;
};
const globalForBoss = globalThis as typeof globalThis & { __loomBossState?: BossState };
const bossState: BossState = globalForBoss.__loomBossState ?? {
  instance: null,
  startPromise: null,
  started: null,
};
if (process.env.NODE_ENV !== 'production') {
  globalForBoss.__loomBossState = bossState;
}

export function createBoss(): PgBoss {
  if (bossState.instance) return bossState.instance;
  const env = getServerEnv();
  const connectionString = env.DATABASE_URL;
  // Tests recreate the singleton per file. The default pool exhausts the
  // testcontainer connection cap, so cap at 2 there. Production keeps the default.
  const isVitest = Boolean(env.VITEST);
  // disabled turns off schedule, supervise, migrate, and instance registration.
  // Enabled passes no flags, so the library defaults stay. Do not infer this
  // from RW_WORKER. A disabled boss still probes the server version, checks the
  // schema, and keeps the queue-cache read and the in-memory wip timer.
  // send, fetch, and complete do not need the subsystems this switch stops.
  const automation = resolveBossAutomationMode(env.RW_BOSS_AUTOMATION);
  bossState.instance = new PgBoss({
    connectionString,
    schema: 'pgboss',
    ...(automation === 'disabled'
      ? { schedule: false, supervise: false, migrate: false, registerInstance: false }
      : {}),
    ...(isVitest ? { max: 2 } : {}),
  });
  return bossState.instance;
}

/**
 * Start the singleton once. send throws before start.
 * The worker starts at boot. App code calls this on the first send and never calls work, so this process does not consume jobs.
 */
export async function getStartedBoss(): Promise<PgBoss> {
  // The in-process worker sets `started` without `startPromise`. After a swallowed
  // 23505 the library flag stays false, so another start() would run startup again.
  if (bossState.started) return bossState.started;
  if (!bossState.startPromise) {
    const boss = createBoss();
    bossState.startPromise = boss
      .start()
      .then(() => {
        bossState.started = boss;
        return boss;
      })
      .catch((err) => {
        // A cached rejection would 500 every later caller until restart. A 23505
        // means the internal send queue exists and the database is already open,
        // so send still works. Any other failure clears the cache and rethrows.
        if (isQueueCreateRace(err)) {
          console.warn(
            '[boss] getStartedBoss(): boss.start() hit pg-boss internal SEND_IT queue create race (23505 queue_pkey) — benign, queue already exists, continuing (YUK-259)',
          );
          bossState.started = boss;
          return boss;
        }
        bossState.startPromise = null;
        throw err;
      });
  }
  return bossState.startPromise;
}

/** Peek without starting. Null means the caller must not become the thing that boots boss. */
export function getRunningBoss(): PgBoss | null {
  return bossState.started;
}

/**
 * The worker starts boss itself and never calls getStartedBoss.
 * Without this, getRunningBoss stays null there and the post-commit wake never sends.
 */
export function markBossStarted(boss: PgBoss): void {
  bossState.started = boss;
}

/** Test-only. Production lifetime is the process. Tests point DATABASE_URL at a new container. */
export function _resetBossForTests(): void {
  bossState.instance = null;
  bossState.startPromise = null;
  bossState.started = null;
}
