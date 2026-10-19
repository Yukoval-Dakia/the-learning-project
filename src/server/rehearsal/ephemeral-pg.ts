// One-shot Postgres for a rehearsal. The image tag matches production.
// Connect only to the container's mapped port.
// Never read DATABASE_URL, and never touch a running compose container.
// Dump and restore run inside the container. The host has no Postgres client.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';

/** Same image tag as the production compose Postgres service. */
export const REHEARSAL_PG_IMAGE = 'pgvector/pgvector:0.8.2-pg16-bookworm';

// Same socket probe as the test setup. A missing socket leaves DOCKER_HOST unset.
function ensureDockerHost(): void {
  if (process.env.DOCKER_HOST) return;
  const orbstack = join(homedir(), '.orbstack/run/docker.sock');
  if (existsSync(orbstack)) {
    process.env.DOCKER_HOST = `unix://${orbstack}`;
    return;
  }
  const dockerDesktop = join(homedir(), '.docker/run/docker.sock');
  if (existsSync(dockerDesktop)) {
    process.env.DOCKER_HOST = `unix://${dockerDesktop}`;
  }
}

export interface EphemeralPg {
  container: StartedPostgreSqlContainer;
  /** Main rehearsal database. sslmode=disable on the mapped port. */
  uri: string;
  user: string;
  /** Database name inside the container. */
  database: string;
  /** Same container, another database. Rollback targets use this. */
  urlFor(database: string): string;
  /** Caller closes the handle. */
  connect(database?: string): { db: Db; close(): Promise<void> };
  /** Non-zero exit throws unless allowFail. */
  exec(
    cmd: string[],
    opts?: { allowFail?: boolean },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** ON_ERROR_STOP. */
  psql(database: string, sqlText: string): Promise<string>;
  createDatabase(name: string): Promise<void>;
  dropDatabase(name: string): Promise<void>;
  /**
   * pg_dump -Fc inside the container. Same custom-format restore surface as pnpm db:dump.
   */
  pgDump(database: string, containerPath: string): Promise<{ sha256: string; bytes: number }>;
  /**
   * Same flags as the production restore in docs/sub5-restore-cli.md.
   * Failure rolls the single transaction back.
   */
  pgRestore(database: string, containerPath: string): Promise<void>;
  /** Base64 the dump out. The host has no Postgres client. */
  exportDump(containerPath: string, hostPath: string): Promise<void>;
  /** Full scripts/migrate.ts startup path against this database. */
  migrate(database: string): Promise<void>;
  stop(): Promise<void>;
}

export async function startEphemeralPg(opts: { database?: string } = {}): Promise<EphemeralPg> {
  ensureDockerHost();
  const container = await new PostgreSqlContainer(REHEARSAL_PG_IMAGE)
    .withCommand(['postgres', '-c', 'max_connections=200'])
    .start();
  const uri = container.getConnectionUri(); // postgres://test:test@host:port/test
  const user = container.getUsername();
  const mainDb = opts.database ?? container.getDatabase();
  if (mainDb !== container.getDatabase()) {
    // Non-default name. Create it on the default connection. Already-exists is a safe rerun.
    const admin = postgres(uri, { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`CREATE DATABASE "${mainDb}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already exists/.test(msg)) throw err;
    } finally {
      await admin.end({ timeout: 5 });
    }
  }
  const urlFor = (database: string) => {
    const u = new URL(uri);
    u.pathname = `/${database}`;
    u.search = 'sslmode=disable';
    return u.toString();
  };

  const exec = async (
    cmd: string[],
    opts2: { allowFail?: boolean } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    const result = await container.exec(cmd);
    const exitCode = result.exitCode;
    const stdout = result.stdout;
    const stderr = result.stderr;
    if (exitCode !== 0 && !opts2.allowFail) {
      throw new Error(
        `container exec failed (${exitCode}): ${cmd.join(' ')}\nstdout: ${stdout.slice(0, 2000)}\nstderr: ${stderr.slice(0, 2000)}`,
      );
    }
    return { stdout, stderr, exitCode };
  };

  const psql = async (database: string, sqlText: string): Promise<string> => {
    const r = await exec([
      'psql',
      '-U',
      user,
      '-d',
      database,
      '-v',
      'ON_ERROR_STOP=1',
      '-Atqc',
      sqlText,
    ]);
    return r.stdout.trim();
  };

  return {
    container,
    uri: urlFor(mainDb),
    user,
    database: mainDb,
    urlFor,
    connect(database) {
      const client = postgres(urlFor(database ?? mainDb), { max: 4, onnotice: () => {} });
      return {
        db: drizzle(client, { schema }) as unknown as Db,
        close: () => client.end({ timeout: 5 }),
      };
    },
    exec,
    psql,
    async createDatabase(name) {
      await psql('postgres', `CREATE DATABASE "${name}"`);
    },
    async dropDatabase(name) {
      // FORCE drops backends an interrupted apply may have left.
      await psql('postgres', `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    },
    async pgDump(database, containerPath) {
      await exec(['pg_dump', '-U', user, '-Fc', '-f', containerPath, database]);
      const sha = await exec(['sha256sum', containerPath]);
      const size = await exec(['stat', '-c', '%s', containerPath]);
      return {
        sha256: sha.stdout.trim().split(/\s+/)[0] ?? '',
        bytes: Number.parseInt(size.stdout.trim(), 10),
      };
    },
    async pgRestore(database, containerPath) {
      // Same flag set as docs/sub5-restore-cli.md. Clean, and one transaction.
      const r = await exec(
        [
          'pg_restore',
          '-U',
          user,
          '-d',
          database,
          '--clean',
          '--if-exists',
          '--no-owner',
          '--no-privileges',
          '--single-transaction',
          '--exit-on-error',
          containerPath,
        ],
        { allowFail: true },
      );
      if (r.exitCode !== 0) {
        throw new Error(
          `pg_restore failed (${r.exitCode}):\n${r.stderr.slice(0, 4000)}\n${r.stdout.slice(0, 2000)}`,
        );
      }
    },
    async exportDump(containerPath, hostPath) {
      const r = await exec(['base64', containerPath]);
      mkdirSync(dirname(hostPath), { recursive: true });
      writeFileSync(hostPath, Buffer.from(r.stdout.trim(), 'base64'));
    },
    async migrate(database) {
      // Same path as the production migrate init container.
      // DATABASE_URL points at this database only.
      const env = { ...process.env, DATABASE_URL: urlFor(database) };
      await new Promise<void>((resolvePromise, reject) => {
        const child = spawn('pnpm', ['exec', 'tsx', 'scripts/migrate.ts'], {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: process.cwd(),
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => {
          out += String(d);
        });
        child.stderr.on('data', (d) => {
          err += String(d);
        });
        child.on('exit', (code) => {
          if (code === 0) resolvePromise();
          else
            reject(
              new Error(
                `migrate failed (${code}) for db=${database}\n${out.slice(-2000)}\n${err.slice(-2000)}`,
              ),
            );
        });
      });
    },
    async stop() {
      await container.stop();
    },
  };
}
