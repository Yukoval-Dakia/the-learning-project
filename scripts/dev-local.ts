import { spawn, spawnSync } from 'node:child_process';
import { config } from 'dotenv';
import { CODE_CONTRACT_EPOCH } from '@/server/migration/contract-epoch/rules';
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

// The TEST app container holds :8787 (loopback and LAN), so dev defaults to :8788: two
// servers on one port would collide, and a browser could silently open TEST instead.
// DEV_PORT overrides; it is passed as API_PORT so a TEST-oriented API_PORT in .env can't win.
const devPort = process.env.DEV_PORT || '8788';
const devOrigin = `http://127.0.0.1:${devPort}`;

// Dev runs against its own Postgres (docker-compose.dev.yml: :5434, role/db loom_dev, own
// volume), never TEST's (:5433/:5544, POSTGRES_* from .env). Credentials here are fixed and
// deliberately ignore POSTGRES_*; only the host/port can be overridden for the guard below.
const DEV_DB = { user: 'loom_dev', password: 'loom_dev', database: 'loom_dev' };
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
  const up = run('docker', [
    'compose',
    '-f',
    'docker-compose.dev.yml',
    '--profile',
    'dev',
    'up',
    '-d',
    '--wait',
    'postgres-dev',
  ]);
  if (up.status !== 0) {
    console.error(
      '[dev-local] could not start the dev Postgres. Is Docker running? On this Mac: `open -ga OrbStack`.',
    );
    process.exit(up.status ?? 1);
  }
  // Existing volume: only pending migrations apply.
  const migrate = run('pnpm', ['db:migrate:local'], devDbEnv);
  if (migrate.status !== 0) process.exit(migrate.status ?? 1);
  // A fresh dev DB only carries the implicit legacy epoch, which fences every request (503).
  // Dev has no cutover to rehearse, so mark the code's epoch active once (idempotent).
  const epoch = run('docker', [
    'compose',
    '-f',
    'docker-compose.dev.yml',
    '--profile',
    'dev',
    'exec',
    '-T',
    'postgres-dev',
    'psql',
    '-U',
    DEV_DB.user,
    '-d',
    DEV_DB.database,
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `insert into contract_epoch (seq, epoch, state, entered_by, note)
     select next.seq, '${CODE_CONTRACT_EPOCH}', 'active', 'dev-local', 'dev database only'
       from (select coalesce(max(seq), 0) + 1 as seq from contract_epoch) next
      where not exists (select 1 from contract_epoch where epoch = '${CODE_CONTRACT_EPOCH}')`,
  ]);
  if (epoch.status !== 0) process.exit(epoch.status ?? 1);
}

// M5-T5c (YUK-321) — gate 选项 b：双进程拓扑（app + worker）。
// LISTEN loop 不消费 boss job，dev 也必须有独立 worker 进程。
// worker:dev 经此处 env 注入 DATABASE_URL，免手动 source .env。
const env: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  NEXT_PUBLIC_BASE_URL: localEnv.NEXT_PUBLIC_BASE_URL,
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

const stop = (code: number | null) => {
  for (const c of children) c.kill('SIGINT');
  process.exit(code ?? 0);
};
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
for (const c of children) c.on('exit', stop);
