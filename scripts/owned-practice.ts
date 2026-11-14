// Owned practice runtime — one callable entry that owns the whole evidence-run
// lifecycle: local-heavy slot (holds for the entire PG lifetime via the parent
// `pnpm owned:practice` script) → throwaway Postgres on the local OrbStack
// socket → real drizzle migration + contract-epoch activation → trusted
// external workload module → raw pins/times/commands → verified cleanup of
// ONLY the owned container and its volume.
//
// CLI:
//   pnpm owned:practice -- --evidence-dir /abs/run --case /abs/workload.mts
//
// The workload is a plain .mts run under tsx with this repo's workspace
// tsconfig: `@/` resolves to src/, `#owned-fixture` resolves to the canonical
// fixture helper in scripts/lib/. Env injected BEFORE the module import:
// DATABASE_URL (owned), OWNED_API_BASE (fresh dist/server.cjs on a random
// loopback port), INTERNAL_TOKEN, OWNED_OUT, OWNED_PG_PORT. A preload guard
// confines the child to those two loopback ports and denies $HOME/.* reads and
// outbound fetch — provider keys never leave, no credentials are inherited.
//
// Failure is preserved raw: a nonzero workload exit or failed cleanup exits
// nonzero — this entry never upgrades a partial run to PASS.

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  OWNED_EXCLUDED_PORTS,
  OwnedPgError,
  type OwnedPgHandle,
  cleanupOwnedPg,
  defaultDockerSocketPath,
  docker,
  freeLoopbackPort,
  startOwnedPg,
} from './lib/owned-pg';
import { testDatabaseUrlRefusalReason } from './local-db-env';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const GUARD_SOURCE = join(REPO, 'scripts/lib/owned-guard.mjs');
const FIXTURE_SPECIFIER = join(REPO, 'scripts/lib/owned-fixture.ts');

interface CommandReceipt {
  at: string;
  end: string;
  argv: string[];
  exit: number | string;
}

const now = () => new Date().toISOString();
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const shaFile = (path: string) => sha256(readFileSync(path));

// The owned runtime ships as a small self-contained file set. While it is
// uncommitted the worktree is dirty by definition; runs are allowed when the
// dirty set is exactly this owned scope (plus the package.json script entry),
// and the working diff is pinned into evidence either way. Any other dirty
// file refuses the run — the runtime never silently proceeds on a tree whose
// product source it cannot account for.
const OWNED_DIRTY_SCOPE = new Set([
  'package.json',
  'scripts/owned-practice.ts',
  'scripts/lib/owned-pg.ts',
  'scripts/lib/owned-fixture.ts',
  'scripts/lib/owned-guard.mjs',
  'README.md',
]);

// Repo-private env files (.env/.env.*, but not *.example templates) may carry
// live credentials. loadEnv in a child fills unset keys from them, which would
// bypass the allowlisted owned env, so the entry refuses to run while any are
// present rather than read or inherit them.
const PRIVATE_ENV_FILE = /^\.env(?:\..+)?$/;
const ENV_EXAMPLE_FILE = /\.example$/;

function privateEnvFiles(repoRoot: string): string[] {
  return readdirSync(repoRoot).filter(
    (name) => PRIVATE_ENV_FILE.test(name) && !ENV_EXAMPLE_FILE.test(name),
  );
}

function dirtyPaths(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const raw = line.replace(/^[A-Z?!]{1,2}\s+/, '');
      // rename entries 'old -> new' — account for both sides.
      return raw.split(' -> ').pop() ?? raw;
    });
}

function arg(name: string): string | null {
  const flag = `--${name}`;
  const index = process.argv.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
  if (index < 0) return null;
  const hit = process.argv[index];
  if (hit === flag) return process.argv[index + 1] ?? null;
  return hit.slice(`${flag}=`.length);
}

function usage(): never {
  console.error(
    '[owned-practice] usage: --evidence-dir /abs/dir --case /abs/workload.mts ' +
      '[--server]  (server boots dist/server.cjs on a random loopback port)',
  );
  process.exit(2);
}

function ownedSlug(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

interface OwnedChild {
  child: ReturnType<typeof spawn>;
  label: string;
  exited: boolean;
}

async function main(): Promise<number> {
  const evidenceDir = arg('evidence-dir');
  const casePath = arg('case');
  const wantServer = process.argv.includes('--server');
  if (!evidenceDir || !isAbsolute(evidenceDir) || !casePath || !isAbsolute(casePath)) usage();
  if (!existsSync(casePath)) {
    console.error(`[owned-practice] case not found: ${casePath}`);
    return 2;
  }
  mkdirSync(evidenceDir, { recursive: true });
  const save = (name: string, value: unknown) =>
    writeFileSync(join(evidenceDir, name), `${JSON.stringify(value, null, 2)}\n`);
  const receipts = (kind: string, data: unknown) =>
    appendFileSync(
      join(evidenceDir, 'harness-receipts.jsonl'),
      `${JSON.stringify({ at: now(), kind, ...(data as object) })}\n`,
    );
  const commands: CommandReceipt[] = [];
  const recordCommand = (argv: string[], exit: number | string, started: string) => {
    commands.push({ at: started, end: now(), argv, exit });
    save('commands.json', commands);
  };

  const runId = ownedSlug('yuk2215');
  const timings: Record<string, string> = { setup_start: now() };
  const pins: Record<string, unknown> = {};
  let exit = 1;
  let pg: OwnedPgHandle | undefined;
  let server: ReturnType<typeof spawn> | undefined;
  const ownedChildren: OwnedChild[] = [];
  const trackedPids = () =>
    ownedChildren.filter((c) => !c.exited && c.child.pid).map((c) => c.child.pid as number);

  // Every spawn below is detached so the child leads its own process group;
  // on SIGINT/SIGTERM we kill each tracked group (negative pid), let main
  // unwind through the normal await/finally path (no process.exit here), and
  // refuse to start any further work. groupKill below is also called from
  // finally so a workload/server child cannot outlive the entry.
  let cancelled: 'SIGINT' | 'SIGTERM' | null = null;
  let cancellationReaping: Promise<void> | undefined;
  const groupKill = (signal: 'SIGTERM' | 'SIGKILL') => {
    for (const pid of trackedPids()) {
      try {
        process.kill(-pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  };
  const waitForChild = (owned: OwnedChild, timeoutMs: number): Promise<void> =>
    new Promise((resolveWait) => {
      if (owned.exited) return resolveWait();
      const timer = setTimeout(() => resolveWait(), timeoutMs);
      owned.child.once('close', () => {
        clearTimeout(timer);
        resolveWait();
      });
    });
  const reapChildren = async (graceMs: number) => {
    const live = ownedChildren.filter((c) => !c.exited);
    if (live.length === 0) return;
    groupKill('SIGTERM');
    await Promise.all(live.map((c) => waitForChild(c, graceMs)));
    const stubborn = ownedChildren.filter((c) => !c.exited);
    if (stubborn.length === 0) return;
    groupKill('SIGKILL');
    await Promise.all(stubborn.map((c) => waitForChild(c, 2000)));
  };
  const onSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    if (cancelled) return;
    cancelled = signal;
    try {
      appendFileSync(
        join(evidenceDir, 'harness-receipts.jsonl'),
        `${JSON.stringify({ at: now(), kind: 'cancelled', signal })}\n`,
      );
    } catch {
      /* evidence dir may be gone; cancellation still proceeds */
    }
    cancellationReaping = reapChildren(8000).catch((error) => {
      receipts('cancel_reap_failed', { message: String(error) });
      exit = 1;
    });
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const throwIfCancelled = () => {
    if (cancelled) throw new OwnedPgError(`cancelled by ${cancelled}`);
  };

  const serverPort = wantServer ? await freeLoopbackPort() : null;
  if (serverPort !== null && OWNED_EXCLUDED_PORTS.has(serverPort)) {
    throw new OwnedPgError('random API port collided with an excluded port');
  }

  try {
    const privateEnv = privateEnvFiles(REPO);
    if (privateEnv.length > 0) {
      throw new OwnedPgError(
        `refusing owned run: repo-private env file(s) present (${privateEnv.join('; ')}) — ` +
          'children would inherit real credentials through loadEnv; remove them before running',
      );
    }

    // ---- preflight: source, runtime, daemon identity, no shared target ----
    const head = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const status = execFileSync('git', ['-C', REPO, 'status', '--porcelain'], {
      encoding: 'utf8',
    }).trim();
    pins.head = head;
    pins.worktreeStatus = status;
    pins.repo = REPO;
    pins.node = process.version;
    pins.pnpm = execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim();
    pins.packageSha256 = shaFile(join(REPO, 'package.json'));
    pins.lockSha256 = existsSync(join(REPO, 'pnpm-lock.yaml'))
      ? shaFile(join(REPO, 'pnpm-lock.yaml'))
      : null;
    pins.tsconfigSha256 = shaFile(join(REPO, 'tsconfig.json'));
    pins.caseSha256 = shaFile(casePath);
    pins.fixtureSha256 = shaFile(FIXTURE_SPECIFIER);
    pins.guardSha256 = shaFile(GUARD_SOURCE);
    pins.entrySha256 = shaFile(join(REPO, 'scripts/owned-practice.ts'));
    pins.ownedPgSha256 = shaFile(join(REPO, 'scripts/lib/owned-pg.ts'));
    save('pins.json', pins);
    receipts('preflight', { head, dirty: status.length > 0, casePath, wantServer });
    if (status.length > 0) {
      const outOfScope = dirtyPaths(status).filter((p) => !OWNED_DIRTY_SCOPE.has(p));
      if (outOfScope.length > 0) {
        throw new OwnedPgError(
          `worktree has dirty files outside the owned-runtime scope: ${outOfScope.join('; ')}`,
        );
      }
      save('working-diff.json', {
        at: now(),
        diff: execFileSync('git', ['-C', REPO, 'diff', 'HEAD'], { encoding: 'utf8' }),
        untracked: execFileSync('git', ['-C', REPO, 'ls-files', '--others', '--exclude-standard'], {
          encoding: 'utf8',
        }).trim(),
      });
    }

    const socketPath = defaultDockerSocketPath();
    const serverVersion = docker(socketPath, ['info', '--format', '{{json .ServerVersion}}']);
    if (serverVersion.status !== 0) {
      throw new OwnedPgError(
        `docker daemon unreachable at ${socketPath}: ${serverVersion.stderr || serverVersion.error?.message}`,
      );
    }
    receipts('daemon', { socketPath, serverVersion: serverVersion.stdout.trim() });
    const existing = docker(socketPath, ['ps', '--format', '{{.ID}}\t{{.Names}}\t{{.Ports}}']);
    save('existing-containers.json', { at: now(), out: existing.stdout });

    // ---- owned Postgres ----
    throwIfCancelled();
    const database = `owned_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    pg = await startOwnedPg({ socketPath, owner: runId, database });
    save('container.json', { at: now(), ...pg, databaseUrl: '<derived>' });
    receipts('owned_pg_started', { cid: pg.cid, port: pg.port, database });
    timings.pg_ready = now();

    const ownedEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      TMPDIR: join(evidenceDir, 'tmp'),
      NODE_ENV: 'test',
      INTERNAL_TOKEN: `owned-${randomUUID()}`,
      RW_WORKER: '0',
      RW_BOSS_AUTOMATION: 'disabled',
      AWS_EC2_METADATA_DISABLED: 'true',
      GCE_METADATA_DISABLED: 'true',
      MEM0_TELEMETRY: 'false',
      OWNED_OUT: evidenceDir,
      OWNED_RUN_ID: runId,
      OWNED_REPO_BASE: REPO,
      OWNED_PG_PORT: String(pg.port),
      OWNED_FIXTURE: FIXTURE_SPECIFIER,
      DATABASE_URL: pg.databaseUrl,
    };
    await mkdir(ownedEnv.TMPDIR as string, { recursive: true });

    // The guard itself must agree this URL is an owned target: loopback only,
    // never a TEST port/name. Reuse the single local-db-env authority rather
    // than re-implementing TEST detection.
    const urlRefusal = testDatabaseUrlRefusalReason(pg.databaseUrl, {
      ...process.env,
      DEV_ALLOW_TEST_DB: undefined,
    });
    if (urlRefusal) {
      throw new OwnedPgError(`owned DATABASE_URL refused by local-db-env: ${urlRefusal}`);
    }

    // ---- migration + epoch via the real migrate module ----
    const tsconfig = join(evidenceDir, 'tsconfig.owned.json');
    await writeFile(
      tsconfig,
      `${JSON.stringify(
        {
          compilerOptions: {
            target: 'esnext',
            module: 'esnext',
            moduleResolution: 'bundler',
            baseUrl: REPO,
            paths: { '@/*': ['./src/*'], '#owned-fixture': ['./scripts/lib/owned-fixture.ts'] },
          },
        },
        null,
        2,
      )}\n`,
    );
    copyFileSync(GUARD_SOURCE, join(evidenceDir, 'guard.mjs'));
    const tsxLoader = join(REPO, 'node_modules/tsx/dist/loader.mjs');
    if (!existsSync(tsxLoader)) {
      throw new OwnedPgError('node_modules absent — run pnpm install in this worktree first');
    }

    const baseArgv = [
      process.execPath,
      '--max-old-space-size=3072',
      '--import',
      join(evidenceDir, 'guard.mjs'),
      '--import',
      tsxLoader,
    ];
    const tsxEnv: NodeJS.ProcessEnv = {
      ...ownedEnv,
      TSX_TSCONFIG_PATH: tsconfig,
      TSX_DISABLE_CACHE: '1',
    };

    const migrationStart = now();
    const migrate = await runCapture(
      [...baseArgv, join(REPO, 'scripts/migrate.ts')],
      { cwd: REPO, env: tsxEnv, ownedChildren, label: 'migration' },
      join(evidenceDir, 'migration'),
    );
    recordCommand(['tsx', 'scripts/migrate.ts'], migrate.exit, migrationStart);
    timings.migration_end = now();
    if (migrate.exit !== 0) throw new OwnedPgError(`migration exited ${migrate.exit}`);

    // ---- optional API server on a random loopback port ----
    if (wantServer) {
      throwIfCancelled();
      const serverBundle = join(REPO, 'dist/server.cjs');
      if (!existsSync(serverBundle)) {
        throw new OwnedPgError(
          'dist/server.cjs missing — build it (pnpm build:server) before --server runs',
        );
      }
      pins.serverCjsSha256 = shaFile(serverBundle);
      save('pins.json', pins);
      const apiPort = serverPort;
      if (apiPort === null) {
        throw new OwnedPgError('--server requested but no API port was reserved');
      }
      const serverEnv = {
        ...ownedEnv,
        NODE_ENV: 'production',
        API_PORT: String(apiPort),
        OWNED_API_PORT: String(apiPort),
      };
      server = spawn(
        process.execPath,
        ['--max-old-space-size=3072', '--import', join(evidenceDir, 'guard.mjs'), serverBundle],
        {
          cwd: REPO,
          env: serverEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        },
      );
      const serverOwned: OwnedChild = { child: server, label: 'server', exited: false };
      ownedChildren.push(serverOwned);
      server.once('close', () => {
        serverOwned.exited = true;
      });
      const serverOut = createWriteStream(join(evidenceDir, 'server.stdout'));
      const serverErr = createWriteStream(join(evidenceDir, 'server.stderr'));
      server.stdout?.pipe(serverOut);
      server.stderr?.pipe(serverErr);
      save('server.json', {
        at: now(),
        argv: server.spawnargs,
        pid: server.pid,
        apiPort,
        serverCjsSha256: pins.serverCjsSha256,
      });
      const apiBase = `http://127.0.0.1:${apiPort}`;
      let ready = false;
      for (let i = 0; i < 240 && !ready; i++) {
        throwIfCancelled();
        if (server.exitCode !== null) {
          throw new OwnedPgError(`built server exited ${server.exitCode} during boot`);
        }
        try {
          const health = await fetch(`${apiBase}/api/health`, {
            signal: AbortSignal.timeout(500),
          });
          if (health.status === 200) ready = true;
        } catch {
          await sleep(250);
        }
      }
      if (!ready) throw new OwnedPgError('built server did not pass /api/health in 60s');
      const readyCheck = await fetch(`${apiBase}/api/ready`, { signal: AbortSignal.timeout(2000) });
      save('server-ready.json', {
        at: now(),
        apiBase,
        health: 200,
        readyStatus: readyCheck.status,
      });
      ownedEnv.OWNED_API_BASE = apiBase;
      ownedEnv.OWNED_API_PORT = String(apiPort);
      tsxEnv.OWNED_API_BASE = apiBase;
      tsxEnv.OWNED_API_PORT = String(apiPort);
      timings.api_ready = now();
    }

    // ---- trusted workload ----
    throwIfCancelled();
    const caseStart = now();
    const workload = await runCapture(
      [...baseArgv, casePath],
      { cwd: REPO, env: tsxEnv, ownedChildren, label: 'workload' },
      join(evidenceDir, 'workload'),
    );
    throwIfCancelled();
    recordCommand(['tsx', casePath], workload.exit, caseStart);
    timings.case_end = now();
    if (workload.exit !== 0) {
      receipts('workload_failed', { exit: workload.exit });
      throw new OwnedPgError(`workload exited ${workload.exit} — raw output preserved`);
    }
    receipts('workload_ok', { exit: workload.exit });
    exit = 0;
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    save('error.json', { at: now(), message, stack: error instanceof Error ? error.stack : null });
    receipts('run_failed', { message });
    exit = 1;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    // Group-kill every tracked child (migration/workload via runCapture and
    // the built server) and reap before touching PG: a workload must not
    // outlive its database, and no owned child may outlive this entry.
    await (cancellationReaping ?? reapChildren(8000));
    if (server) {
      save('server-cleanup.json', {
        at: now(),
        pid: server.pid,
        exitCode: server.exitCode,
        signalCode: server.signalCode,
      });
    }
    if (pg) {
      const receipt = await cleanupOwnedPg(pg);
      save('cleanup.json', { at: now(), owner: pg.owner, cid: pg.cid, ...receipt });
      receipts('cleanup', { ok: receipt.ok, error: receipt.error ?? null });
      if (!receipt.ok) exit = 1;
    }
    timings.finished = now();
    save('timings.json', timings);
    save('finish.json', { at: now(), exit, runId });
    console.log(JSON.stringify({ runId, exit, evidenceDir }));
  }
  return exit;
}

function runCapture(
  argv: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    ownedChildren?: OwnedChild[];
    label: string;
  },
  prefix: string,
): Promise<{ exit: number }> {
  return new Promise((resolvePromise) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const owned: OwnedChild = { child, label: options.label, exited: false };
    options.ownedChildren?.push(owned);
    child.stdout?.on('data', (d: Buffer) => appendFileSync(`${prefix}.stdout`, d));
    child.stderr?.on('data', (d: Buffer) => appendFileSync(`${prefix}.stderr`, d));
    child.once('close', (code) => {
      owned.exited = true;
      resolvePromise({ exit: code ?? 1 });
    });
    child.once('error', (error) => {
      owned.exited = true;
      appendFileSync(`${prefix}.stderr`, String(error));
      resolvePromise({ exit: 1 });
    });
  });
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('[owned-practice] fatal:', error);
    process.exit(1);
  });
