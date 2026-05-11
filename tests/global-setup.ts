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
