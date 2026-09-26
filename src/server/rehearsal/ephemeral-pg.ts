// ====================================================================
// YUK-1057 — ephemeral Postgres（隔离演练靶库；绝不触碰本机生产 compose）
// ====================================================================
//
// testcontainers 起一次性 pgvector/pgvector:0.8.2-pg16-bookworm（与生产
// docker-compose.yml 的 postgres 服务同镜像 tag——pin 不变量），默认 db
// 'test'，pg_dump/pg_restore 在【容器内】执行（本机无 pg 客户端，生产
// dump 路径也在容器内 —— 与 mac-daily-dump.sh 同构）。
//
// 隔离红线：
//   - 只连容器映射端口（127.0.0.1 随机端口），绝不解析 .env / DATABASE_URL。
//   - 不启动/停止/触碰 any running compose container。
//   - pg_dump/pg_restore 全程容器内；dump 以 sha256+base64 出容器落工件目录。

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';

/** 与 docker-compose.yml postgres.image 同 tag（生产同镜像演练）。 */
export const REHEARSAL_PG_IMAGE = 'pgvector/pgvector:0.8.2-pg16-bookworm';

// tests/global-setup.ts 同款：OrbStack/Docker Desktop socket 自动探测。
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
  /** 主演练库连接串（sslmode=disable；127.0.0.1 随机端口）。 */
  uri: string;
  user: string;
  /** 容器内默认库名（PostgreSqlContainer 约定 'test'）。 */
  database: string;
  /** 指向同容器内另一 db 的连接串（rollback target 用）。 */
  urlFor(database: string): string;
  /** drizzle Db 句柄（schema-bound；调用方负责 close）。 */
  connect(database?: string): { db: Db; close(): Promise<void> };
  /** 容器内执行命令（stdout/stderr 文本；非零 exitCode 抛错）。 */
  exec(
    cmd: string[],
    opts?: { allowFail?: boolean },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** psql 便捷口（ON_ERROR_STOP）。 */
  psql(database: string, sqlText: string): Promise<string>;
  createDatabase(name: string): Promise<void>;
  dropDatabase(name: string): Promise<void>;
  /**
   * 生产形态 dump：容器内 `pg_dump -Fc`（custom format，与 mac-daily-dump.sh
   * / `pnpm db:dump` 的 restore 面一致）。dump 落容器内临时路径，sha256 回传。
   */
  pgDump(database: string, containerPath: string): Promise<{ sha256: string; bytes: number }>;
  /**
   * 容器内 `pg_restore`（custom format → 目标库）。`--clean --if-exists`
   * 清目标库既有对象；单事务 + exit-on-error 失败即整体回滚（与
   * docs/sub5-restore-cli.md 的生产恢复命令同 flag 集）。
   */
  pgRestore(database: string, containerPath: string): Promise<void>;
  /** dump 文件以 base64 出容器 → 工件目录（二进制安全）。 */
  exportDump(containerPath: string, hostPath: string): Promise<void>;
  /** 迁移：tsx scripts/migrate.ts（DATABASE_URL=靶库；走完整启动面准备）。 */
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
    // 非默认库：默认连接面不变，这里先建库（幂等重跑安全）。
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
      // FORCE：终止残留连接（中断的 apply/演练步骤可能留 backend）。
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
      // 与 docs/sub5-restore-cli.md 的灾难恢复路径同 flag 集：clean + 单事务。
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
      // 完整启动面（drizzle migrations + builtin seed + trait reconcile +
      // canonical projections + contract epoch marker 读回）—— 与生产
      // `migrate` init container 同路径（scripts/migrate.ts）。
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
