// Owned throwaway Postgres lifecycle for the owned-practice runtime: one
// pgvector container on the local OrbStack unix socket, bound to a random
// 127.0.0.1 port, labelled `tlp.owner=<owner>` so cleanup can verify it only
// ever removes what this run created. No remote daemons, no global prune, no
// pattern kills — every inspect before remove re-asserts exact cid + owner
// label + volume-only mounts.

import { execFileSync } from 'node:child_process';
import { Socket, createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const OWNED_PG_MEMORY_BYTES = 768 * 1024 * 1024;
export const OWNED_PG_CPUS = '1';
// Ports other lanes own on this host: TEST db relays (5433/5544), the dev
// Postgres (5434), the TEST app relay (8787). Random bindings must skip them.
export const OWNED_EXCLUDED_PORTS = new Set([5433, 5434, 5544, 8787]);
export const OWNED_PG_IMAGE = 'pgvector/pgvector:pg16';
// Reject the shared dev database and TEST's name; an owned case always gets a
// fresh per-run database distinct from both.
const FORBIDDEN_DB_NAMES = new Set(['loom', 'loom_dev']);

export interface OwnedPgHandle {
  cid: string;
  owner: string;
  port: number;
  database: string;
  user: string;
  socketPath: string;
  databaseUrl: string;
  mounts: Array<{ Type?: string; Name?: string; Destination?: string }>;
}

export interface OwnedPgCleanupReceipt {
  containerAbsent: boolean;
  healthyDaemon: boolean;
  volumes: Array<{ name: string; absent: boolean }>;
  ok: boolean;
  error?: string;
}

export class OwnedPgError extends Error {}

export function defaultDockerSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OWNED_DOCKER_SOCK;
  if (explicit) {
    if (!explicit.startsWith('/')) {
      throw new OwnedPgError(
        `OWNED_DOCKER_SOCK must be a local unix socket path, got "${explicit}" (remote daemons are not owned targets)`,
      );
    }
    return explicit;
  }
  return join(homedir(), '.orbstack', 'run', 'docker.sock');
}

export function dockerHost(socketPath: string): string {
  return `unix://${socketPath}`;
}

export function docker(
  socketPath: string,
  args: string[],
  timeoutMs = 30_000,
): { status: number | null; stdout: string; stderr: string; error?: Error } {
  try {
    const stdout = execFileSync('docker', ['--host', dockerHost(socketPath), ...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout: stdout ?? '', stderr: '' };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: typeof e.status === 'number' ? e.status : null,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function checked(socketPath: string, args: string[], timeoutMs = 30_000): string {
  const result = docker(socketPath, args, timeoutMs);
  if (result.status !== 0) {
    throw new OwnedPgError(
      `docker ${args.join(' ')} exited ${result.status}: ${result.stderr || result.error?.message || ''}`,
    );
  }
  return result.stdout;
}

function assertOwnedDatabaseName(database: string): void {
  if (FORBIDDEN_DB_NAMES.has(database) || /^loom_dev(_|$)/.test(database)) {
    throw new OwnedPgError(
      `owned database name "${database}" collides with a shared dev/TEST name`,
    );
  }
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(database)) {
    throw new OwnedPgError(`owned database name "${database}" is not a plain identifier`);
  }
}

export async function freeLoopbackPort(): Promise<number> {
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const bound = (probe.address() as { port: number }).port;
      probe.close(() => resolve(bound));
    });
  });
  if (OWNED_EXCLUDED_PORTS.has(port)) return freeLoopbackPort();
  return port;
}

async function tcpReady(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    socket.setTimeout(300);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
    socket.connect(port, '127.0.0.1');
  });
}

export async function startOwnedPg(options: {
  socketPath?: string;
  owner: string;
  database: string;
  user?: string;
}): Promise<OwnedPgHandle> {
  const socketPath = options.socketPath ?? defaultDockerSocketPath();
  const { owner, database } = options;
  const user = options.user ?? 'synthetic';
  assertOwnedDatabaseName(database);
  if (!/^[a-z0-9][a-z0-9_-]{2,80}$/.test(owner)) {
    throw new OwnedPgError(`owner "${owner}" is not a safe container-name slug`);
  }

  checked(socketPath, ['info', '--format', '{{json .ServerVersion}}']);
  checked(socketPath, ['image', 'inspect', OWNED_PG_IMAGE, '--format', '{{json .Id}}']);

  const cid = checked(socketPath, [
    'run',
    '--pull=never',
    '-d',
    '--name',
    owner,
    '--memory',
    String(OWNED_PG_MEMORY_BYTES),
    '--cpus',
    OWNED_PG_CPUS,
    '--label',
    `tlp.owner=${owner}`,
    '-p',
    '127.0.0.1::5432',
    '-e',
    `POSTGRES_DB=${database}`,
    '-e',
    `POSTGRES_USER=${user}`,
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    OWNED_PG_IMAGE,
  ]).trim();

  try {
    const inspected = JSON.parse(checked(socketPath, ['inspect', cid]))[0] as {
      Id: string;
      Name: string;
      Image: string;
      HostConfig: { Memory: number; NanoCpus: number };
      NetworkSettings: {
        Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
      };
      Config: { Labels: Record<string, string> };
      Mounts: OwnedPgHandle['mounts'];
    };
    const bindings = inspected.NetworkSettings.Ports['5432/tcp'];
    const binding = bindings?.[0];
    if (
      inspected.Id !== cid ||
      inspected.Name !== `/${owner}` ||
      inspected.Config.Labels['tlp.owner'] !== owner
    ) {
      throw new OwnedPgError('created container failed identity re-inspection');
    }
    if (inspected.HostConfig.Memory !== OWNED_PG_MEMORY_BYTES) {
      throw new OwnedPgError(
        `container memory ${inspected.HostConfig.Memory} != ${OWNED_PG_MEMORY_BYTES}`,
      );
    }
    if (bindings?.length !== 1 || !binding || binding.HostIp !== '127.0.0.1') {
      throw new OwnedPgError('container is not bound to a single 127.0.0.1 port');
    }
    const port = Number(binding.HostPort);
    if (OWNED_EXCLUDED_PORTS.has(port)) {
      throw new OwnedPgError(`container bound excluded port ${port}`);
    }
    if (!inspected.Mounts.length || !inspected.Mounts.every((m) => m.Type === 'volume')) {
      throw new OwnedPgError('container has non-volume mounts');
    }

    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      if (await tcpReady(port)) {
        const probe = docker(socketPath, [
          'exec',
          cid,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          user,
          '-d',
          database,
        ]);
        ready = probe.status === 0;
      }
      if (!ready) await sleep(100);
    }
    if (!ready) throw new OwnedPgError('postgres did not become ready in 12s');

    return {
      cid,
      owner,
      port,
      database,
      user,
      socketPath,
      databaseUrl: `postgres://${user}@127.0.0.1:${port}/${database}`,
      mounts: inspected.Mounts,
    };
  } catch (error) {
    // Best-effort removal of the container this call created; identity was
    // proven above (or never claimed), so `rm -fv cid` cannot hit a stranger.
    try {
      docker(socketPath, ['rm', '-fv', cid]);
    } catch {
      // leave the failure visible in the thrown error below
    }
    throw error instanceof Error ? error : new OwnedPgError(String(error));
  }
}

function ownedVolumeNames(mounts: OwnedPgHandle['mounts']): string[] {
  return mounts
    .filter((m) => m.Type === 'volume')
    .map((m) => m.Name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

export async function cleanupOwnedPg(handle: OwnedPgHandle): Promise<OwnedPgCleanupReceipt> {
  const receipt: OwnedPgCleanupReceipt = {
    containerAbsent: false,
    healthyDaemon: false,
    volumes: [],
    ok: false,
  };
  try {
    const inspect = docker(handle.socketPath, ['inspect', handle.cid]);
    if (inspect.status === 0) {
      const final = JSON.parse(inspect.stdout)[0] as {
        Id: string;
        Name: string;
        Config: { Labels: Record<string, string> };
        Mounts: OwnedPgHandle['mounts'];
      };
      if (
        final.Id !== handle.cid ||
        final.Name !== `/${handle.owner}` ||
        final.Config.Labels['tlp.owner'] !== handle.owner
      ) {
        throw new OwnedPgError(
          `refusing to remove ${handle.cid}: ownership labels do not match ${handle.owner}`,
        );
      }
      const rm = docker(handle.socketPath, ['rm', '-fv', handle.cid]);
      if (rm.status !== 0) {
        throw new OwnedPgError(`docker rm -fv ${handle.cid} exited ${rm.status}: ${rm.stderr}`);
      }
      const volumes = ownedVolumeNames(final.Mounts);
      for (const name of volumes) {
        const probe = docker(handle.socketPath, ['volume', 'inspect', name]);
        receipt.volumes.push({
          name,
          absent: probe.status !== 0 && /no such volume/i.test(probe.stderr),
        });
      }
    } else {
      receipt.containerAbsent = true;
      for (const name of ownedVolumeNames(handle.mounts)) {
        const probe = docker(handle.socketPath, ['volume', 'inspect', name]);
        receipt.volumes.push({
          name,
          absent: probe.status !== 0 && /no such volume/i.test(probe.stderr),
        });
      }
    }
    const absent = docker(handle.socketPath, ['inspect', handle.cid]);
    receipt.containerAbsent =
      receipt.containerAbsent || (absent.status !== 0 && /no such object/i.test(absent.stderr));
    receipt.healthyDaemon =
      docker(handle.socketPath, ['info', '--format', '{{json .ServerVersion}}']).status === 0;
    receipt.ok =
      receipt.containerAbsent &&
      receipt.healthyDaemon &&
      (receipt.volumes.length === 0 || receipt.volumes.every((v) => v.absent));
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error);
  }
  return receipt;
}
