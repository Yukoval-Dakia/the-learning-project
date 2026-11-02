import { spawn, spawnSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { config } from 'dotenv';
import { CODE_CONTRACT_EPOCH } from '@/server/migration/contract-epoch/rules';
import { devDatabaseName } from './dev-worktree-db';
import { buildLocalDatabaseUrl, buildLocalDevEnv } from './local-db-env';

// YUK-365 (Codex review P2, Finding 2): load .env.local BEFORE .env, both
// non-overriding, so the AI provider toggle (AI_PROVIDER_OVERRIDE /
// CLAUDE_CODE_OAUTH_TOKEN, owner places these in .env.local) is in the parent env
// passed to all three spawned children. The children (rw:api → server/env loadEnv,
// worker:dev → scripts/worker.ts loadEnv) also load .env.local themselves, so this
// is belt-and-braces — but it keeps dev-local's view consistent with the API's.
// `override: false` keeps real shell env winning, matching loadEnv's "only fill
// unset keys" contract.
config({ path: '.env.local', override: false });
config({ path: '.env', override: false });

const localEnv = buildLocalDevEnv(process.env);

// The TEST app container holds :8787 (loopback and LAN), so dev never binds it: two
// servers on one port would collide, and a browser could silently open TEST instead.
// Without DEV_PORT the first free 127.0.0.1 port from 8788 up is taken, so parallel
// worktrees each get their own origin. DEV_PORT pins the port and is used as-is; either
// way it is passed as API_PORT so a TEST-oriented API_PORT in .env can't win.
async function firstFreePort(from: number): Promise<number> {
  for (let port = from; port < from + 100; port++) {
    if (port === 8787) continue;
    const free = await new Promise<boolean>((resolve) => {
      const probe = createNetServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new Error(`[dev-local] no free 127.0.0.1 port in ${from}–${from + 99}`);
}
const devPort = process.env.DEV_PORT ?? String(await firstFreePort(8788));
const devOrigin = `http://127.0.0.1:${devPort}`;

// Dev runs against the shared dev Postgres container (docker-compose.dev.yml: :5434,
// role loom_dev, one named volume), never TEST's (:5433/:5544, POSTGRES_* from .env),
// but each worktree gets its own database inside it — loom_dev_<name>_<path hash>,
// derived in dev-worktree-db.ts. Credentials are fixed and deliberately ignore
// POSTGRES_*; only the host/port can be overridden for the guard below.
const DEV_DB = { user: 'loom_dev', password: 'loom_dev', database: devDatabaseName() };
const TEST_DB_PORTS = ['5433', '5544'];
const devDbEnv = {
  POSTGRES_USER: DEV_DB.user,
  POSTGRES_PASSWORD: DEV_DB.password,
  POSTGRES_DB: DEV_DB.database,
  LOCAL_POSTGRES_HOST: process.env.LOCAL_POSTGRES_HOST ?? '127.0.0.1',
  LOCAL_POSTGRES_PORT: process.env.LOCAL_POSTGRES_PORT ?? '5434',
};

const allowTestDb = process.env.DEV_ALLOW_TEST_DB === '1';
const testDbName = process.env.POSTGRES_DB ?? 'loom';
const targetsTest =
  TEST_DB_PORTS.includes(devDbEnv.LOCAL_POSTGRES_PORT) || DEV_DB.database === testDbName;
if (targetsTest && !allowTestDb) {
  console.error(
    `[dev-local] refusing to start: the database target ${devDbEnv.LOCAL_POSTGRES_HOST}:${devDbEnv.LOCAL_POSTGRES_PORT} is TEST's (ports ${TEST_DB_PORTS.join('/')} or database "${testDbName}"). ` +
      'dev:local would run a dev API and worker that write data and take jobs there.\n' +
      '[dev-local] Use the dev database instead: unset LOCAL_POSTGRES_PORT and run `pnpm dev:local` (it starts Postgres on :5434 by itself).\n' +
      "[dev-local] To really use TEST's database, set DEV_ALLOW_TEST_DB=1.",
  );
  process.exit(1);
}

let databaseUrl: string;
if (allowTestDb) {
  // Explicit override: keep the pre-isolation behaviour (POSTGRES_* from .env, port 5433).
  databaseUrl = localEnv.DATABASE_URL;
  console.warn(
    `\n${'!'.repeat(78)}\n` +
      '!! DEV_ALLOW_TEST_DB=1 — dev:local is NOT isolated from TEST.                   !!\n' +
      '!! The dev API and worker will write to and consume jobs from the TEST database. !!\n' +
      `!! Target: ${databaseUrl.replace(/:\/\/[^@]*@/, '://***@')}\n` +
      `${'!'.repeat(78)}\n`,
  );
} else {
  databaseUrl = buildLocalDatabaseUrl(devDbEnv);
  const run = (cmd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
    spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...extraEnv } });
  const composeDev = (args: string[]) => [
    'compose',
    '-f',
    'docker-compose.dev.yml',
    '--profile',
    'dev',
    ...args,
  ];
  const psql = (args: string[]) => [
    'exec',
    '-T',
    'postgres-dev',
    'psql',
    '-U',
    DEV_DB.user,
    ...args,
  ];
  const up = run('docker', composeDev(['up', '-d', '--wait', 'postgres-dev']));
  if (up.status !== 0) {
    console.error(
      '[dev-local] could not start the dev Postgres. Is Docker running? On this Mac: `open -ga OrbStack`.',
    );
    process.exit(up.status ?? 1);
  }
  // One database per worktree inside the shared container. Create it via the postgres
  // maintenance DB when absent (the loom_dev role is a superuser); pg_database is
  // checked first so re-runs and parallel worktrees stay no-ops for each other.
  const dbExists = spawnSync(
    'docker',
    composeDev(
      psql([
        '-d',
        'postgres',
        '-tAc',
        `select 1 from pg_database where datname = '${DEV_DB.database}'`,
      ]),
    ),
    { encoding: 'utf8', env: process.env },
  );
  if (dbExists.status !== 0) process.exit(dbExists.status ?? 1);
  if (dbExists.stdout.trim() !== '1') {
    const create = run(
      'docker',
      composeDev(
        psql([
          '-d',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          `create database "${DEV_DB.database}"`,
        ]),
      ),
    );
    if (create.status !== 0) process.exit(create.status ?? 1);
    console.log(`[dev-local] created worktree database ${DEV_DB.database}`);
  }
  // Existing volume: only pending migrations apply.
  const migrate = run('pnpm', ['db:migrate:local'], devDbEnv);
  if (migrate.status !== 0) process.exit(migrate.status ?? 1);
  // A fresh dev DB only carries the implicit legacy epoch, which fences every request (503).
  // Dev has no cutover to rehearse, so mark the code's epoch active once (idempotent).
  const epoch = run(
    'docker',
    composeDev(
      psql([
        '-d',
        DEV_DB.database,
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `insert into contract_epoch (seq, epoch, state, entered_by, note)
         select next.seq, '${CODE_CONTRACT_EPOCH}', 'active', 'dev-local', 'dev database only'
           from (select coalesce(max(seq), 0) + 1 as seq from contract_epoch) next
          where not exists (select 1 from contract_epoch where epoch = '${CODE_CONTRACT_EPOCH}')`,
      ]),
    ),
  );
  if (epoch.status !== 0) process.exit(epoch.status ?? 1);
  // The API (RW_WORKER=1) and the worker both launch DBOS against tlp_dbos. DBOS's migration
  // runner takes no cross-process lock, so on an empty database the two deadlock. Migrate once
  // here; both launches then find the schema current and skip migration. Production already
  // has a single DBOS launcher (separate worker, app without RW_WORKER).
  const dbosSchema = run('pnpm', ['exec', 'dbos', 'schema', databaseUrl, '--schema', 'tlp_dbos']);
  if (dbosSchema.status !== 0) process.exit(dbosSchema.status ?? 1);
  // A few admitted questions so the pages have something to serve without a model provider.
  // Runs only on this dev-DB path (never DEV_ALLOW_TEST_DB); the script re-checks the database
  // name itself and skips questions that already exist.
  const seed = run('pnpm', ['seed:dev-questions'], {
    DATABASE_URL: databaseUrl,
    SEED_SYNTHETIC_OK: '1',
  });
  if (seed.status !== 0) process.exit(seed.status ?? 1);
}

// M5-T5c (YUK-321) — gate 选项 b：双进程拓扑（app + worker）。
// LISTEN loop 不消费 boss job，dev 也必须有独立 worker 进程。
// worker:dev 经此处 env 注入 DATABASE_URL，免手动 source .env。
const env: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  NEXT_PUBLIC_BASE_URL: devOrigin,
  API_PORT: devPort,
  // The dev worker renders worksheets against this dev server, not the TEST app.
  WORKSHEET_RENDER_APP_ORIGIN: devOrigin,
};

// RW_FRONTDOOR=dev serves the Start front door through the Vite dev server inside the API
// process (server/dev-frontdoor.ts): HMR for pages, no build step, no second watcher.
const api = spawn('pnpm', ['rw:api'], { stdio: 'inherit', env: { ...env, RW_FRONTDOOR: 'dev' } });
const worker = spawn('pnpm', ['worker:dev'], { stdio: 'inherit', env });
const children = [api, worker];
console.log(
  `[dev-local] open ${devOrigin}/ (Vite HMR; /api/* on the same origin; database ${databaseUrl.replace(/:\/\/[^@]*@/, '://***@')})`,
);
if (!process.env.DEV_PORT) console.log(`[dev-local] port ${devPort} auto-selected`);

const stop = (code: number | null) => {
  for (const c of children) c.kill('SIGINT');
  process.exit(code ?? 0);
};
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
for (const c of children) c.on('exit', stop);
