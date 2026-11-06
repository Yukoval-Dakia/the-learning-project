import { existsSync } from 'node:fs';

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
// The same ports as numbers. Ports must be compared AFTER parsing: '05433',
// ' 5433' and '5433\n' all reach the driver as port 5433, so a raw string
// comparison lets a padded or zero-padded TEST port through.
const TEST_DB_PORT_NUMBERS: readonly number[] = TEST_DB_PORTS.map(Number);
function parsedPort(raw: string | undefined): number {
  const n = Number(String(raw ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : Number.NaN;
}
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
  const port = parsedPort(target.port);
  if (TEST_DB_PORT_NUMBERS.includes(port)) {
    return `port ${target.port} (parses to ${port}) is a TEST Postgres port (${TEST_DB_PORTS.join('/')})`;
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

// Loopback hosts. The WHATWG URL parser does not normalize the host of a
// non-special scheme like postgres:// (`LOCALHOST` and `localhost.` stay as
// written), so compare lowercased and without the root dot. `0.0.0.0`/`[::]`
// are the wildcard addresses: a client dialling them reaches this machine.
// The raw-DATABASE_URL guard below only refuses targets on a loopback host:
// containers and release hosts connect via service names (`postgres:5432`) or
// remote addresses and must pass untouched.
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  return (
    host === 'localhost' ||
    host === '[::1]' ||
    host === '0.0.0.0' ||
    host === '[::]' ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// Production is exactly the runtime that must keep binding 8787 and may point
// at non-local databases. Read process.env.NODE_ENV directly: esbuild's
// --define replaces this exact expression with "production" in dist/*.cjs, so
// the bundle stays production even when the runtime env omits NODE_ENV. Going
// through a parameter (`env.NODE_ENV`) defeats that substitution and let the
// bundle fence itself — verified against node dist/server.cjs.
export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV?.trim() === 'production';
}

// TEST-target judgment for scripts that read DATABASE_URL directly (drizzle-kit
// db:* via drizzle.config.ts, worker:dev, and every CLI importing
// scripts/load-env.ts). Same single owner and same TEST definition as
// testDbRefusalReason, applied to a parsed URL instead of a resolved target.
// Returns null (no refusal) for a missing or unparseable URL — the driver's own
// error is the correct failure there.
//
// The driver does not necessarily connect where the URL's authority points:
// `pg`/postgres-js let `?host=`/`?port=` query parameters override it and fall
// back to PGHOST/PGPORT when the URL omits them. Judge the effective target with
// that precedence (query > URL > PG* > driver default) so a URL that says
// `postgres:5432` but carries `?host=127.0.0.1&port=5544` cannot slip through.
export function testDatabaseUrlRefusalReason(
  rawUrl: string | undefined,
  env: LocalEnvInput = process.env,
): string | null {
  if (env.DEV_ALLOW_TEST_DB === '1') return null;
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const queryHost = nonEmpty(url.searchParams.get('host'));
  const queryPort = nonEmpty(url.searchParams.get('port'));
  const envHost = nonEmpty(env.PGHOST);
  const envPort = nonEmpty(env.PGPORT);

  const host = queryHost ?? nonEmpty(url.hostname) ?? envHost ?? 'localhost';
  const portRaw = queryPort ?? nonEmpty(url.port) ?? envPort ?? '5432';
  const port = parsedPort(portRaw);
  if (isLoopbackHost(host) && TEST_DB_PORT_NUMBERS.includes(port)) {
    return `loopback target ${host}:${portRaw} (parses to ${port}) is a TEST Postgres port (${TEST_DB_PORTS.join('/')})`;
  }

  // Database-name refusal keeps the pre-existing scope: only when the URL's own
  // authority is loopback. Extending it to query/env hosts is a separate ticket.
  if (!isLoopbackHost(url.hostname)) return null;
  let database: string;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
  if (database === TEST_DB_NAME) {
    return `loopback database "${database}" is TEST's database name`;
  }
  return null;
}

// Fail-closed entry for the raw-DATABASE_URL surface: refuses before any
// connection when the URL is a loopback TEST target. DEV_ALLOW_TEST_DB=1 is the
// only override (same contract as guardLocalDbTarget).
export function guardDatabaseUrl(label: string, env: LocalEnvInput = process.env): void {
  const rawUrl = env.DATABASE_URL;
  if (env.DEV_ALLOW_TEST_DB === '1') {
    const shown = rawUrl?.replace(/:[^:@/]*@/, ':***@');
    console.warn(
      `[${label}] DEV_ALLOW_TEST_DB=1 — TEST-target guard bypassed; DATABASE_URL ${shown}`,
    );
    return;
  }
  const reason = testDatabaseUrlRefusalReason(rawUrl, env);
  if (reason) {
    console.error(
      `[${label}] refusing: DATABASE_URL ${rawUrl?.replace(/:[^:@/]*@/, ':***@')} is TEST's — ${reason}.\n` +
        `[${label}] Local scripts target this worktree's dev database on the dev Postgres (:5434); ` +
        'point DATABASE_URL there, or set DEV_ALLOW_TEST_DB=1 to override.',
    );
    process.exit(1);
  }
}

// The TEST app relay owns 8787 on this Mac (scripts/test-nas/relay.py). A dev
// API that binds it can coexist with the relay: the relay holds 127.0.0.1 while
// `serve()` without a hostname takes the IPv6 wildcard, so both listen and
// people silently reach the wrong app. This is a LOCAL DEV fence only:
// production stays able to bind 8787 (Dockerfile API_PORT=8787, NODE_ENV baked
// into the esbuild bundles), and containers are recognized by /.dockerenv.
// DEV_ALLOW_TEST_DB=1 only relaxes the database target and does not bypass this.
export const TEST_APP_RELAY_PORT = 8787;

export function isContainerRuntime(): boolean {
  return existsSync('/.dockerenv');
}

export interface DevApiPortContext {
  inContainer?: boolean;
  inProduction?: boolean;
}

export function devApiPortRefusalReason(
  rawPort: string | number | undefined,
  context: DevApiPortContext = {},
): string | null {
  const inContainer = context.inContainer ?? isContainerRuntime();
  const inProduction = context.inProduction ?? isProductionRuntime();
  if (inContainer || inProduction) return null;
  const port = typeof rawPort === 'number' ? rawPort : parsedPort(rawPort);
  if (port !== TEST_APP_RELAY_PORT) return null;
  return `port ${TEST_APP_RELAY_PORT} is the TEST app relay's port (scripts/test-nas/relay.py)`;
}

// Fail-closed entry for local dev API launches: exits before the socket binds.
// `label` names the entry in the message; production/container launches return
// immediately. `dev:local` overrides the context to stay strict even when an
// inherited NODE_ENV says production.
export function guardDevApiPort(
  rawPort: string | number | undefined,
  label: string,
  context: DevApiPortContext = {},
): void {
  const reason = devApiPortRefusalReason(rawPort, context);
  if (!reason) return;
  console.error(
    `[${label}] refusing to bind: ${reason}.\n` +
      `[${label}] Pick another port: API_PORT=8788 (dev:local: DEV_PORT=8788), ` +
      'or run `pnpm dev:local` — it takes the first free 127.0.0.1 port from 8788.\n' +
      `[${label}] DEV_ALLOW_TEST_DB=1 does not bypass this; container images set API_PORT=8787 and keep working.`,
  );
  process.exit(1);
}

export function localDatabaseUrl(target: LocalDbTarget): string {
  const { user, password, database, host, port } = target;
  // Emit the port as its parsed number when it parses: a padded or zero-padded
  // dev port ('05434') would otherwise build an invalid or surprising URL. TEST
  // spellings never get this far — the guard already refused them.
  const portPart = String(parsedPort(port) || port);
  return `postgres://${encode(user)}:${encode(password)}@${host}:${portPart}/${encode(database)}?sslmode=disable`;
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
