import { spawnSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let container: StartedPostgreSqlContainer | undefined;

export async function setup() {
  container = await new PostgreSqlContainer('postgres:16').start();
  const uri = container.getConnectionUri();
  process.env.TEST_DATABASE_URL = uri;
  // Drizzle pushes schema into the fresh container. We point drizzle-kit at
  // TEST_DATABASE_URL via env so it does not touch the dev Neon DB.
  const result = spawnSync('pnpm', ['db:push', '--force'], {
    env: { ...process.env, DATABASE_URL: uri },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`drizzle-kit push failed (exit ${result.status}) against test container`);
  }
}

export async function teardown() {
  await container?.stop();
}
