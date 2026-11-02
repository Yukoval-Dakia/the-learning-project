import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getServerEnv } from '@/server/env';
import { DB_POOL_MAX } from './pool';
import * as schema from './schema';

// Fail fast on missing DATABASE_URL. An empty-string fallback (`?? ''`) would let
// the module load and defer the failure to the first query, surfacing a confusing
// "tcp connect to ''" far from the root cause.
const env = getServerEnv();
const databaseUrl = env.DATABASE_URL;

// Singleton client. postgres-js pools per module instance, so a second module
// evaluation in one process would open a second pool that nobody end()s. Cache the
// pool on globalThis outside production; production runs one module cache per
// process and never writes to globalThis.
// Disable SSL for local/test connections (localhost or 127.0.0.1) so testcontainers
// and local dev containers work without a TLS certificate. Also honour an explicit
// `sslmode=disable` in the URL — the option object otherwise wins over URL params,
// which silently breaks docker-compose-internal hostnames like `postgres:5432`.
const isLocalConnection = /localhost|127\.0\.0\.1/.test(databaseUrl);
const hasSslDisable = /[?&]sslmode=disable\b/.test(databaseUrl);
const globalForDb = globalThis as typeof globalThis & {
  __loomQueryClient?: ReturnType<typeof postgres>;
};
const queryClient =
  globalForDb.__loomQueryClient ??
  postgres(databaseUrl, {
    ssl: isLocalConnection || hasSslDisable ? false : 'require',
    // 池上限与 admin config 读面同源，不另抄一份数字。
    max: DB_POOL_MAX,
  });
if (env.NODE_ENV !== 'production') {
  globalForDb.__loomQueryClient = queryClient;
}

export const db = drizzle(queryClient, { schema });
export type Db = typeof db;

/**
 * Transaction handle (the argument passed to `db.transaction(async (tx) => …)`).
 * 查询/写入 API 与 `Db` 一致，但不含 `$client`；需要在调用方事务内写入时接收
 * `Tx | Db`。
 */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
