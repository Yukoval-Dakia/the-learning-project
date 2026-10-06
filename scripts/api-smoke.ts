/**
 * api:smoke — run the Postman collection headlessly via Newman.
 *
 * Mirrors `scripts/dev-local.ts`: loads INTERNAL_TOKEN from `.env` and injects
 * it into a private temporary Newman environment, keeping it out of process
 * arguments and the committed Postman environment (which ships empty).
 *
 * Newman itself is NOT a project dependency — we run it through `pnpm dlx` so
 * the smoke runner stays zero-footprint. First invocation fetches newman into
 * the pnpm store; later runs are cached.
 *
 * Usage:
 *   pnpm api:smoke                 # default: only the `health` folder (server-up probe, safe)
 *   pnpm api:smoke knowledge       # run a single route folder by name
 *   pnpm api:smoke --no-folder     # run the WHOLE collection (mutating endpoints included — see caveat)
 *   API_SMOKE_BASE_URL=http://localhost:3000 pnpm api:smoke   # override target
 *
 * Caveat: most non-GET endpoints expect real IDs in collection variables and
 * will 4xx (or mutate data) with the placeholder examples. The default `health`
 * folder is the only guaranteed-safe target. Point at a running dev server
 * (`pnpm dev:local`, default :3001) before running.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';
import environment from '../postman/learning-local.postman_environment.json';

config({ path: '.env', override: false });

const COLLECTION = 'postman/learning-api.postman_collection.json';
const DEFAULT_FOLDER = 'health';

const token = process.env.INTERNAL_TOKEN ?? '';
if (!token) {
  console.warn(
    '[api:smoke] INTERNAL_TOKEN not found in .env — authed endpoints will 401. ' +
      'health still works (middleware-exempt).',
  );
}

const baseUrl = process.env.API_SMOKE_BASE_URL ?? 'http://localhost:3001';

// Folder selection: first non-flag arg is a folder name; `--no-folder` runs all.
const argv = process.argv.slice(2);
const runAll = argv.includes('--no-folder');
const folderArg = argv.find((a) => !a.startsWith('-'));
const folder = runAll ? undefined : (folderArg ?? DEFAULT_FOLDER);
// Pass through any extra newman flags the caller appended (e.g. --verbose, --bail).
const passthrough = argv.filter((a) => a.startsWith('-') && a !== '--no-folder' && a !== folderArg);

// mkdtemp creates an owner-only directory and honors umask. The token is never
// part of an argv or filename, and the committed environment stays unchanged.
const environmentDir = mkdtempSync(join(tmpdir(), 'tlp-api-smoke-'));
const environmentPath = join(environmentDir, 'environment.json');
const cleanup = () => rmSync(environmentDir, { recursive: true, force: true });
process.once('exit', cleanup);
writeFileSync(
  environmentPath,
  JSON.stringify({
    ...environment,
    values: environment.values.map((variable) =>
      variable.key === 'internalToken' ? { ...variable, value: token } : variable,
    ),
  }),
);

const newmanArgs = [
  'dlx',
  'newman@6',
  'run',
  COLLECTION,
  '--environment',
  environmentPath,
  '--env-var',
  `baseUrl=${baseUrl}`,
  ...(folder ? ['--folder', folder] : []),
  ...passthrough,
];

console.log(`[api:smoke] target=${baseUrl} folder=${folder ?? '(whole collection)'}`);

const childEnv = { ...process.env };
delete childEnv.INTERNAL_TOKEN;
const child = spawn('pnpm', newmanArgs, { stdio: 'inherit', env: childEnv });

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.once(signal, () => {
    cleanup();
    child.kill(signal);
    process.kill(process.pid, signal);
  });
}

child.on('error', () => {
  cleanup();
  console.error('[api:smoke] failed to start Newman');
  process.exit(1);
});

child.on('exit', (code, signal) => {
  cleanup();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
