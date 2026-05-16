import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let container: StartedPostgreSqlContainer | undefined;

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
  container = await new PostgreSqlContainer('postgres:16').start();
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
}

export async function teardown() {
  await container?.stop();
}
