import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { DB_FORK_COUNT, dbForkDatabaseName } from './db-fork-constants';

let container: StartedPostgreSqlContainer | undefined;

// YUK-252 — db-test parallelisation budget.
// vitest.db.config.ts consumes DB_FORK_COUNT as maxWorkers. Each worker connects
// to its own cloned database created below via `CREATE DATABASE … TEMPLATE`.

// testcontainers reads DOCKER_HOST or falls back to /var/run/docker.sock. On
// macOS with OrbStack the socket lives at ~/.orbstack/run/docker.sock and
// there is no /var/run/docker.sock symlink, so auto-detect and set it.
function ensureDockerHost() {
  if (process.env.DOCKER_HOST) return;
  const orbstack = join(homedir(), '.orbstack/run/docker.sock');
  if (existsSync(orbstack)) {
    process.env.DOCKER_HOST = `unix://${orbstack}`;
    return;
  }
  const dockerDesktop = join(homedir(), '.docker/run/docker.sock');
  if (existsSync(dockerDesktop)) {
    process.env.DOCKER_HOST = `unix://${dockerDesktop}`;
  }
}

export async function setup() {
  ensureDockerHost();
  // Bump max_connections: default Postgres allows 100. YUK-252 runs the db
  // partition across DB_FORK_COUNT forks, each connecting to its own cloned
  // database; per fork ~16-20 connections accumulate as pg-boss + drizzle pools
  // recycle (boss caps at 2, drizzle test pool at 4, plus boss schema churn).
  // The current budget still stays well under 500. 500 leaves
  // comfortable headroom without measurable cost on a single-developer
  // testcontainer. (Previously this guarded a single accumulating fork.)
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withCommand(['postgres', '-c', 'max_connections=500'])
    .start();
  const uri = container.getConnectionUri();
  process.env.TEST_DATABASE_URL = uri;
  process.env.DATABASE_URL = uri;
  // Phase 1c.1 Step 8 — switch from `db:push --force` to `drizzle-kit migrate`.
  //
  // `db:push` only diffs `src/db/schema.ts` against the live DB and skips
  // hand-written `.sql` files in `drizzle/` (notably the `knowledge_mastery`
  // view DDL in 0005_*.sql). Tests that touch the view fail with "relation
  // does not exist" or have to inline the view DDL (Step 5 workaround).
  //
  // `drizzle-kit migrate` walks `drizzle/meta/_journal.json` and applies every
  // migration file in order — including hand-written ones — so the view + GIN
  // index land in the test container the same way they will in production.
  // We point at TEST_DATABASE_URL via env so drizzle-kit does not touch dev DB.
  const result = spawnSync('pnpm', ['db:migrate'], {
    env: { ...process.env, DATABASE_URL: uri },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`drizzle-kit migrate failed (exit ${result.status}) against test container`);
  }

  // YUK-252 — clone the freshly-migrated container database into N per-fork
  // databases so the db partition can run with `pool: 'forks'` without test
  // files racing on shared rows. Each fork connects to its own cloned database
  // name derived from VITEST_POOL_ID (wired in tests/setup.db-fork.ts).
  //
  // Why CREATE DATABASE … TEMPLATE: it physically copies the template at the
  // filesystem level (milliseconds), so we migrate exactly once (above) and
  // every fork inherits the identical schema + view + GIN index for free.
  //
  // Two hard constraints this code respects:
  //  1. We must connect to a *different* database than the template — Postgres
  //     refuses CREATE DATABASE while the template has any active session. The
  //     container's default db is `test`, so we connect to the always-present
  //     maintenance db `postgres` to issue the clones.
  //  2. The clones are created *sequentially*. Concurrent CREATE … TEMPLATE
  //     against the same template contends on a template lock and can fail;
  //     serial creation is cheap (filesystem copy) and avoids that entirely.
  //
  // The migrate step above ran in a `spawnSync` child that has already exited,
  // so the template (`test`) has no lingering connections, and globalSetup runs
  // in the main process *before* any worker fork — nothing else is connected.
  const adminUrl = new URL(uri);
  const templateDb = adminUrl.pathname.replace(/^\//, '') || 'test';
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1 });
  try {
    for (let i = 1; i <= DB_FORK_COUNT; i++) {
      const forkDb = dbForkDatabaseName(i);
      // Drop-then-create makes the setup idempotent across re-runs that reuse a
      // long-lived container (e.g. local watch sessions); FORCE evicts any stale
      // sessions left over from a previous run.
      //
      // postgres.js cannot parameterize DDL identifiers. forkDb/templateDb are
      // internal safe identifiers from the shared fork constants + container URL.
      await admin.unsafe(`DROP DATABASE IF EXISTS "${forkDb}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${forkDb}" TEMPLATE "${templateDb}"`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

export async function teardown() {
  await container?.stop();
}
