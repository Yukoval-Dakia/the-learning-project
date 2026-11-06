import { devDatabaseName } from './dev-worktree-db';

export interface LocalEnvInput {
  [key: string]: string | undefined;
  POSTGRES_USER?: string;
  POSTGRES_PASSWORD?: string;
  POSTGRES_DB?: string;
  LOCAL_POSTGRES_HOST?: string;
  LOCAL_POSTGRES_PORT?: string;
  LOCAL_NEXT_PORT?: string;
  DEV_ALLOW_TEST_DB?: string;
  DEV_DB_NAME?: string;
}

// Host ports the NAS tunnel used to relay to TEST's Postgres (closed
// 2026-11-06, YUK-1906): any resolved target on one of these is aiming at TEST.
export const TEST_DB_PORTS: readonly string[] = ['5433', '5544'];
// TEST's database name (the compose stack's POSTGRES_DB) — never a legitimate
// local-script target, on any host/port.
export const TEST_DB_NAME = 'loom';
// The default local target is the shared dev Postgres (docker-compose.dev.yml):
// host port 5434, role loom_dev, one loom_dev_* database per worktree.
const DEV_DB_PORT = '5434';
const DEV_DB_ROLE = 'loom_dev';

export interface LocalDbTarget {
  user: string;
  password: string;
  database: string;
  host: string;
  port: string;
}

// The local default is the worktree dev database — never TEST. POSTGRES_USER /
// POSTGRES_PASSWORD belong to the TEST/production stack and are honoured only
// under DEV_ALLOW_TEST_DB=1 (the same contract dev:local uses). POSTGRES_DB
// stays the database selector in both modes so an explicit TEST name resolves
// visibly for the guard below to refuse. No default points at a TEST port: an
// override that wants TEST must name LOCAL_POSTGRES_PORT=5433/5544 itself.
export function resolveLocalDbTarget(env: LocalEnvInput = process.env): LocalDbTarget {
  const allowTest = env.DEV_ALLOW_TEST_DB === '1';
  return {
    user: allowTest ? (env.POSTGRES_USER ?? 'loom') : DEV_DB_ROLE,
    password: allowTest ? (env.POSTGRES_PASSWORD ?? 'loom') : DEV_DB_ROLE,
    database: env.POSTGRES_DB ?? (allowTest ? TEST_DB_NAME : devDatabaseName(env)),
    host: env.LOCAL_POSTGRES_HOST ?? '127.0.0.1',
    port: env.LOCAL_POSTGRES_PORT ?? DEV_DB_PORT,
  };
}

// The single TEST-target judgment shared by dev:local, dev:reset and every
// script that connects to a resolved local target. Returns why the RESOLVED
// target is TEST's, or null — including when DEV_ALLOW_TEST_DB=1 opted in.
export function testDbRefusalReason(
  target: Pick<LocalDbTarget, 'port' | 'database'>,
  env: LocalEnvInput = process.env,
): string | null {
  if (env.DEV_ALLOW_TEST_DB === '1') return null;
  if (TEST_DB_PORTS.includes(target.port)) {
    return `port ${target.port} is a TEST Postgres port (${TEST_DB_PORTS.join('/')})`;
  }
  if (target.database === TEST_DB_NAME) {
    return `database "${target.database}" is TEST's database name`;
  }
  return null;
}

// Fail-closed entry for scripts: resolves the target, prints a loud line under
// DEV_ALLOW_TEST_DB=1, and exits before any connection when the target is
// TEST's. Callers that must stay fail-visible instead of exiting (e.g.
// delivery-evidence) use resolveLocalDbTarget + testDbRefusalReason directly.
export function guardLocalDbTarget(label: string, env: LocalEnvInput = process.env): LocalDbTarget {
  const target = resolveLocalDbTarget(env);
  if (env.DEV_ALLOW_TEST_DB === '1') {
    console.warn(
      `[${label}] DEV_ALLOW_TEST_DB=1 — TEST-target guard bypassed; ` +
        `target ${target.host}:${target.port}/${target.database}`,
    );
    return target;
  }
  const reason = testDbRefusalReason(target, env);
  if (reason) {
    console.error(
      `[${label}] refusing: resolved target ${target.host}:${target.port}/${target.database} is TEST's (${reason}).\n` +
        `[${label}] The default is this worktree's dev database on the dev Postgres (:${DEV_DB_PORT}); ` +
        'unset POSTGRES_DB and LOCAL_POSTGRES_PORT to use it, or set DEV_ALLOW_TEST_DB=1 to override.',
    );
    process.exit(1);
  }
  return target;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

export function localDatabaseUrl(target: LocalDbTarget): string {
  const { user, password, database, host, port } = target;
  return `postgres://${encode(user)}:${encode(password)}@${host}:${port}/${encode(database)}?sslmode=disable`;
}

export function buildLocalDatabaseUrl(env: LocalEnvInput = process.env): string {
  return localDatabaseUrl(resolveLocalDbTarget(env));
}

export function buildLocalDevEnv(env: LocalEnvInput = process.env): {
  DATABASE_URL: string;
  NEXT_PUBLIC_BASE_URL: string;
  LOCAL_NEXT_PORT: string;
} {
  const port = env.LOCAL_NEXT_PORT ?? '3001';

  return {
    DATABASE_URL: buildLocalDatabaseUrl(env),
    NEXT_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    LOCAL_NEXT_PORT: port,
  };
}
