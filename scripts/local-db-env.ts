import { existsSync } from 'node:fs';
import { createServer } from 'node:net';

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
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '::' ||
    host === '0.0.0.0' ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

function decodeDatabase(pathname: string): string | undefined {
  try {
    return decodeURIComponent(pathname.replace(/^\//, ''));
  } catch {
    return undefined;
  }
}

function describeDatabaseTarget(
  rawUrl: string | undefined,
  env: LocalEnvInput = process.env,
): string {
  if (!rawUrl) return '(unset)';
  try {
    const url = new URL(rawUrl);
    const query = rawQueryParams(rawUrl);
    const host =
      url.hostname ||
      splitCommaList(query.get('host'))[0] ||
      splitCommaList(env.PGHOST)[0] ||
      'localhost';
    const port =
      url.port || splitCommaList(query.get('port'))[0] || splitCommaList(env.PGPORT)[0] || '5432';
    const database = decodeDatabase(url.pathname) || '(none)';
    return `${host}:${port}/${database}`;
  } catch {
    return '(unparseable)';
  }
}

// parseInt, not Number: `5544xyz` reaches the driver as 5544.
function parseIntPort(raw: string | undefined): number {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : Number.NaN;
}

function splitCommaList(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

interface HostPortCandidate {
  host: string;
  port?: string;
}

// `db:5432`, `[::1]:5544`, `::1`, `/var/run/postgresql` — split a port only when
// it is the single colon outside brackets; bare IPv6 stays a host.
function splitHostPort(raw: string): HostPortCandidate | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) return null;
    const host = value.slice(0, end + 1);
    const rest = value.slice(end + 1);
    if (rest === '') return { host };
    if (!rest.startsWith(':')) return null;
    return { host, port: rest.slice(1) || undefined };
  }
  const colons = value.split(':').length - 1;
  if (colons === 0) return { host: value };
  if (colons > 1) return { host: value };
  const at = value.indexOf(':');
  return { host: value.slice(0, at) || 'localhost', port: value.slice(at + 1) || undefined };
}

// Fallback authority extraction for URLs WHATWG rejects (comma-separated
// multi-host). Returns the text after credentials and before path/query/hash.
function rawAuthority(rawUrl: string): string | null {
  const scheme = rawUrl.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//);
  if (!scheme) return null;
  const rest = rawUrl.slice(scheme[0].length);
  const end = rest.search(/[/?#]/);
  let authority = (end < 0 ? rest : rest.slice(0, end)).trim();
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  return authority || null;
}

function rawDatabaseName(rawUrl: string): string | undefined {
  const scheme = rawUrl.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//);
  if (!scheme) return undefined;
  const rest = rawUrl.slice(scheme[0].length);
  const slash = rest.indexOf('/');
  if (slash < 0) return undefined;
  let path = rest.slice(slash + 1);
  const end = path.search(/[?#]/);
  if (end >= 0) path = path.slice(0, end);
  return path ? decodeDatabase(path) : undefined;
}

function rawQueryParams(rawUrl: string): URLSearchParams {
  const q = rawUrl.indexOf('?');
  if (q < 0) return new URLSearchParams();
  const rest = rawUrl.slice(q + 1);
  const hash = rest.indexOf('#');
  return new URLSearchParams(hash < 0 ? rest : rest.slice(0, hash));
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
// testDbRefusalReason, applied to a DATABASE_URL instead of a resolved target.
//
// Two consumers read the same URL: postgres-js ignores `?host=`/`?port=`, pg
// honours them, and both fall back to PGHOST/PGPORT. Rather than guess which
// one wins, refuse when the union of every candidate host:port (URL authority,
// comma lists, query params, PG* env) contains a loopback host with a TEST port.
// The database name is checked for every loopback candidate too. Unparseable
// non-empty URLs refuse instead of passing (fail closed), and production is the
// only skip (guardDatabaseUrl).
export function testDatabaseUrlRefusalReason(
  rawUrl: string | undefined,
  env: LocalEnvInput = process.env,
): string | null {
  if (env.DEV_ALLOW_TEST_DB === '1') return null;
  if (!rawUrl) return null;

  let url: URL | undefined;
  try {
    url = new URL(rawUrl);
  } catch {
    url = undefined;
  }

  const candidates: HostPortCandidate[] = [];
  if (url) {
    if (url.hostname) candidates.push({ host: url.hostname, port: url.port || undefined });
  } else {
    const authority = rawAuthority(rawUrl);
    if (!authority) return 'DATABASE_URL has no parseable host';
    for (const item of authority.split(',')) {
      const parsed = splitHostPort(item);
      if (!parsed) return `DATABASE_URL authority "${authority}" is not parseable`;
      candidates.push(parsed);
    }
  }

  const query = rawQueryParams(rawUrl);
  const hosts = new Set<string>();
  for (const candidate of candidates) if (candidate.host) hosts.add(candidate.host);
  for (const value of query.getAll('host'))
    for (const host of splitCommaList(value)) hosts.add(host);
  for (const host of splitCommaList(env.PGHOST)) hosts.add(host);
  // Both drivers default to localhost when no host is named anywhere. Without
  // this, `postgres:///dev` + PGPORT=5544 and `postgres:///loom` had no host
  // candidate and slipped through.
  if (hosts.size === 0) hosts.add('localhost');

  const portRaws = new Set<string>();
  for (const candidate of candidates) if (candidate.port) portRaws.add(candidate.port);
  for (const value of query.getAll('port'))
    for (const port of splitCommaList(value)) portRaws.add(port);
  for (const port of splitCommaList(env.PGPORT)) portRaws.add(port);
  // Only a host with no port and no PGPORT reaches the driver default. 5432 is
  // never a TEST port, so adding it cannot refuse a legitimate target.
  if (portRaws.size === 0) portRaws.add('5432');

  const loopbackHosts = [...hosts].filter(isLoopbackHost);
  if (loopbackHosts.length === 0) return null;
  for (const portRaw of portRaws) {
    const port = parseIntPort(portRaw);
    if (TEST_DB_PORT_NUMBERS.includes(port)) {
      return `loopback host ${loopbackHosts[0]} with port ${portRaw} (parses to ${port}) is a TEST Postgres target (ports ${TEST_DB_PORTS.join('/')})`;
    }
  }
  const database = url ? decodeDatabase(url.pathname) : rawDatabaseName(rawUrl);
  if (database === TEST_DB_NAME) {
    return `loopback database "${database}" is TEST's database name`;
  }
  return null;
}

// Fail-closed entry for the raw-DATABASE_URL surface: production skips it (the
// same NODE_ENV switch as the port guard — an explicit escape hatch, not a
// security boundary); otherwise it refuses before any connection when the
// candidate union contains a loopback TEST target. DEV_ALLOW_TEST_DB=1 is the
// only local override (same contract as guardLocalDbTarget).
export function guardDatabaseUrl(label: string, env: LocalEnvInput = process.env): void {
  if (isProductionRuntime()) return;
  const rawUrl = env.DATABASE_URL;
  if (env.DEV_ALLOW_TEST_DB === '1') {
    console.warn(
      `[${label}] DEV_ALLOW_TEST_DB=1 — TEST-target guard bypassed; target ${describeDatabaseTarget(rawUrl, env)}`,
    );
    return;
  }
  const reason = testDatabaseUrlRefusalReason(rawUrl, env);
  if (reason) {
    console.error(
      `[${label}] refusing: target ${describeDatabaseTarget(rawUrl, env)} — ${reason}.\n` +
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

// A listener on either stack must make the port busy: probing only 127.0.0.1
// missed a process on `::`/`[::1]` twice (8787, 8788). A missing IPv6 stack is
// not a busy port; every other listen error is treated as occupied.
function portIsFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => {
      resolve(
        error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL' || error.code === 'ENOTSUP',
      );
    });
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

// First port free on IPv4 loopback and IPv6 (::1 and wildcard), skipping the
// TEST app relay port. Both stacks are probed so a `*:port` or `[::1]:port`
// listener is detected even when `127.0.0.1:port` is free.
export async function firstFreePort(from: number): Promise<number> {
  for (let port = from; port < from + 100; port++) {
    if (port === TEST_APP_RELAY_PORT) continue;
    if (
      (await portIsFree(port, '127.0.0.1')) &&
      (await portIsFree(port, '::1')) &&
      (await portIsFree(port, '::'))
    ) {
      return port;
    }
  }
  throw new Error(`[dev-local] no free IPv4/IPv6 port in ${from}–${from + 99}`);
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
