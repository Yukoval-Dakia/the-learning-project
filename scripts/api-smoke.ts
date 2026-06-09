/**
 * api:smoke — run the Postman collection headlessly via Newman.
 *
 * Mirrors `scripts/dev-local.ts`: loads INTERNAL_TOKEN from `.env` and injects
 * it (plus baseUrl) into Newman as env-vars, so the secret never lands in the
 * committed `postman/learning-local.postman_environment.json` (it ships empty).
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
import { config } from 'dotenv';

config({ path: '.env', override: false });

const COLLECTION = 'postman/learning-api.postman_collection.json';
const ENVIRONMENT = 'postman/learning-local.postman_environment.json';
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

const newmanArgs = [
  'dlx',
  'newman@6',
  'run',
  COLLECTION,
  '--environment',
  ENVIRONMENT,
  '--env-var',
  `internalToken=${token}`,
  '--env-var',
  `baseUrl=${baseUrl}`,
  ...(folder ? ['--folder', folder] : []),
  ...passthrough,
];

console.log(`[api:smoke] target=${baseUrl} folder=${folder ?? '(whole collection)'}`);

const child = spawn('pnpm', newmanArgs, { stdio: 'inherit', env: process.env });

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
