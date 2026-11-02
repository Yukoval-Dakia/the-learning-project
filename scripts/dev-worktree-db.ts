// One database per worktree inside the shared postgres-dev container, so parallel
// `pnpm dev:local` runs never share data and resetting one worktree cannot wipe
// another's. The name is deterministic from the worktree root: same worktree →
// same name every run; different worktrees differ in basename and/or path hash.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';

const LEGACY_DEV_DATABASE = 'loom_dev';
export const DEV_DATABASE_PREFIX = `${LEGACY_DEV_DATABASE}_`;
// Postgres hard limit on identifier length.
const MAX_NAME_LENGTH = 63;

// Names any dev tooling may accept: per-worktree `loom_dev_*` plus the legacy
// shared `loom_dev`. Anything else (TEST's `loom`, arbitrary names) is refused.
export const DEV_DATABASE_PATTERN = /^loom_dev(_[a-z0-9_]+)?$/;

function worktreeRoot(): string {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const raw = top.status === 0 ? top.stdout.trim() : process.cwd();
  return realpathSync(raw);
}

export function devDatabaseName(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DEV_DB_NAME) return env.DEV_DB_NAME;
  const root = worktreeRoot();
  const base =
    basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'worktree';
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 8);
  const room = MAX_NAME_LENGTH - DEV_DATABASE_PREFIX.length - hash.length - 1;
  return `${DEV_DATABASE_PREFIX}${base.slice(0, room)}_${hash}`;
}
