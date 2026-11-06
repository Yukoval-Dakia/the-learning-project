// `pnpm dev:reset` drops ONLY this worktree's dev database inside the shared
// postgres-dev container (docker-compose.dev.yml); the next `pnpm dev:local`
// recreates, migrates and re-seeds it. Other worktrees' databases and the legacy
// shared `loom_dev` are never dropped here, and the volume is never touched —
// `docker compose down -v` would delete every worktree's data at once.
import { spawnSync } from 'node:child_process';
import { config } from 'dotenv';
import { DEV_DATABASE_PREFIX, devDatabaseName } from './dev-worktree-db';
import { testDbRefusalReason } from './local-db-env';

config({ path: '.env.local', override: false });
config({ path: '.env', override: false });

const database = devDatabaseName();
const host = process.env.LOCAL_POSTGRES_HOST ?? '127.0.0.1';
const port = process.env.LOCAL_POSTGRES_PORT ?? '5434';
// Shared TEST-target judgment (scripts/local-db-env.ts); the port arm is the
// reachable one here — the database is always a loom_dev_* worktree name.
const refusal = testDbRefusalReason({ port, database }, process.env);
if (refusal) {
  console.error(
    `[dev-reset] refusing: ${host}:${port} — ${refusal}. Point LOCAL_POSTGRES_PORT back at the dev container (:5434), or set DEV_ALLOW_TEST_DB=1.`,
  );
  process.exit(1);
}
// The derived name always carries the prefix; a DEV_DB_NAME override without it —
// including the legacy shared `loom_dev` and TEST's `loom` — is refused outright.
if (!database.startsWith(DEV_DATABASE_PREFIX)) {
  console.error(
    `[dev-reset] refusing: "${database}" is not a per-worktree dev database (${DEV_DATABASE_PREFIX}*). Only the current worktree's own database is ever dropped.`,
  );
  process.exit(1);
}

const compose = (args: string[]) =>
  spawnSync('docker', ['compose', '-f', 'docker-compose.dev.yml', '--profile', 'dev', ...args], {
    stdio: 'inherit',
    env: process.env,
  });

const up = compose(['up', '-d', '--wait', 'postgres-dev']);
if (up.status !== 0) {
  console.error('[dev-reset] could not reach the dev Postgres. Is Docker running?');
  process.exit(up.status ?? 1);
}
const drop = compose([
  'exec',
  '-T',
  'postgres-dev',
  'psql',
  '-U',
  'loom_dev',
  '-d',
  'postgres',
  '-v',
  'ON_ERROR_STOP=1',
  '-c',
  `drop database if exists "${database}" with (force)`,
]);
if (drop.status !== 0) process.exit(drop.status ?? 1);
console.log(
  `[dev-reset] dropped ${database}; the next \`pnpm dev:local\` recreates, migrates and re-seeds it.`,
);
